import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  hasCalendarCredentials,
} from "@/lib/google-calendar";
import { generatePrepBrief } from "@/lib/prep-brief";
import { resolveCoachConfig } from "@/lib/authz";
import type { calendar_v3 } from "googleapis";

export interface DeliverBriefsResult {
  status: "skipped" | "completed";
  reason?: string;
  generated?: number;
  skipped?: number;
  failed?: number;
  errors?: string[];
}

// Stop generating briefs before Vercel kills the function (maxDuration 300s
// on the workday-sync route). This budget spans ALL coaches in a run, not each
// coach — two coaches must still finish inside one function invocation.
// Remaining sessions are reported in errors rather than silently lost.
const TIME_BUDGET_MS = 240_000;

// Must cover the gap between workday-sync runs in vercel.json
// ("0 12,18 * * 1-5"): 6h between runs + 30min slack for cron jitter.
// Change this if that schedule changes. Known accepted gaps: sessions
// starting before 11:00 UTC weekdays (an hour before the 12:00 run, i.e.
// before ~6am CDT), weekend sessions (cron is weekdays-only), and sessions
// booked after the last run that would have covered them (e.g. booked at
// 18:05 UTC for the same evening) get no auto-brief — the manual Generate
// Brief button covers all three.
const CRON_GAP_LOOKAHEAD_MINUTES = 6 * 60 + 30;

// Upper bound on calendar events fetched per window, per coach. A 6.5h window
// for one coach tops out well under this; events past the cap would silently
// get no brief.
const MAX_WINDOW_EVENTS = 25;

// Look back one hour so a failed or killed prior run can be re-covered:
// Vercel crons never retry, so without this a transient 12:00 failure
// permanently dropped every brief before the 18:00 run. The ±1h
// existing-brief dedup makes re-coverage idempotent, and a brief seconds
// into a session is still useful; sessions older than this get no brief
// (manual button only) rather than a paid LLM call nobody will read.
const RECOVERY_LOOKBACK_MINUTES = 60;

// The columns resolveCoachConfig needs, plus the id to scope clients by.
const COACH_BRIEF_SELECT = {
  id: true,
  loginEmail: true,
  workEmails: true,
  googleCalendarId: true,
  coachingTitleFilter: true,
  calendarSyncEnabled: true,
  defaultHourlyRate: true,
} as const;

type BriefCoach = {
  id: string;
  loginEmail: string;
  workEmails: string[];
  googleCalendarId: string | null;
  coachingTitleFilter: string | null;
  calendarSyncEnabled: boolean;
  defaultHourlyRate: unknown;
};

interface BriefAccumulator {
  generated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Generate prep briefs for sessions starting within the lookahead window, for
 * EVERY coach with a configured, sync-enabled calendar. Each coach's calendar
 * is matched only against that coach's own synopsis-bearing clients — briefs
 * are per-client, so one coach's run can never touch another's clients.
 *
 * The window is max(briefDeliveryMinutes, CRON_GAP_LOOKAHEAD_MINUTES), so each
 * run pre-generates briefs for every session before the next scheduled run, and
 * reaches RECOVERY_LOOKBACK_MINUTES into the past so a failed prior run is
 * partially re-covered instead of dropped. Sequential re-runs are idempotent
 * via the existing-brief check (same client + session date within 1 hour);
 * concurrent calls are not guarded.
 */
export async function deliverDueBriefs(
  // Absolute Date.now() past which no further work starts. The cron passes one
  // route-level deadline shared with calendar sync so the two phases together
  // stay inside maxDuration; a standalone call falls back to its own 240s cap.
  deadline?: number
): Promise<DeliverBriefsResult> {
  if (!hasCalendarCredentials()) {
    return { status: "skipped", reason: "Calendar not configured" };
  }

  const settings = await prisma.coachSettings.findFirst();
  // Deterministic order (owner first) so a budget cutoff strands the same coach
  // every time rather than a random one.
  const coaches = await prisma.coach.findMany({
    where: { status: { not: "INACTIVE" }, googleCalendarId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: COACH_BRIEF_SELECT,
  });
  if (coaches.length === 0) {
    return { status: "skipped", reason: "Calendar not configured" };
  }

  const now = new Date();
  // briefDeliveryMinutes acts as a floor if it's ever set higher than the
  // cron-gap lookahead. It is practice-wide, so the window is the same for
  // every coach. Window overlap between runs is harmless — the existing-brief
  // check dedupes.
  const lookaheadMinutes = Math.max(
    settings?.briefDeliveryMinutes || 30,
    CRON_GAP_LOOKAHEAD_MINUTES
  );
  const windowStart = new Date(now.getTime() - RECOVERY_LOOKBACK_MINUTES * 60 * 1000);
  const windowEnd = new Date(now.getTime() + lookaheadMinutes * 60 * 1000);

  const acc: BriefAccumulator = { generated: 0, skipped: 0, failed: 0, errors: [] };
  // One budget for the whole run: the cron's route-level deadline, or a 240s cap
  // for a standalone call. Shared across coaches — the 300s cron is one budget.
  const effectiveDeadline = deadline ?? Date.now() + TIME_BUDGET_MS;
  let processedAnyCoach = false;

  for (const coach of coaches) {
    const config = resolveCoachConfig(coach, settings);
    if (!config.googleCalendarId || !config.calendarSyncEnabled) continue;

    if (Date.now() > effectiveDeadline) {
      acc.errors.push(
        `time budget exhausted before coach ${coach.loginEmail} — their sessions need the manual Generate Brief button or the next run`
      );
      break;
    }

    processedAnyCoach = true;
    try {
      const budgetExhausted = await deliverCoachBriefs(
        coach,
        config,
        windowStart,
        windowEnd,
        effectiveDeadline,
        acc
      );
      if (budgetExhausted) break; // a coach hit the shared budget mid-loop
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      acc.errors.push(`coach ${coach.loginEmail}: ${msg}`);
    }
  }

  if (!processedAnyCoach && acc.errors.length === 0) {
    return { status: "skipped", reason: "Calendar not configured" };
  }

  return {
    status: "completed",
    generated: acc.generated,
    skipped: acc.skipped,
    failed: acc.failed,
    errors: acc.errors,
  };
}

/**
 * Generate briefs for one coach's upcoming sessions. Returns true if the shared
 * time budget was exhausted mid-coach (the caller must stop the whole run).
 */
async function deliverCoachBriefs(
  coach: BriefCoach,
  config: ReturnType<typeof resolveCoachConfig>,
  windowStart: Date,
  windowEnd: Date,
  deadline: number,
  acc: BriefAccumulator
): Promise<boolean> {
  const calendar = getCalendar();
  // The calendar fetch and the client load are independent — overlap the
  // external API round-trip with the Neon query.
  const [res, clients] = await Promise.all([
    calendar.events.list({
      calendarId: config.googleCalendarId!,
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: MAX_WINDOW_EVENTS,
    }),
    // ONLY this coach's clients. Only clients with at least one synopsis-bearing
    // session can actually get a brief — generatePrepBrief throws without one,
    // and a calendar-only client (sessions synced but never recorded) would
    // otherwise fail and retry on every run forever, reporting eternal
    // "partial" runs.
    prisma.client.findMany({
      where: {
        coachId: coach.id,
        status: { not: "CHURNED" },
        sessions: { some: { synopsis: { not: null } } },
      },
      select: { id: true, email: true, secondaryEmails: true },
    }),
  ]);

  const rawEvents = res.data.items || [];
  // nextPageToken is the authoritative truncation signal — a page can come
  // back shorter than maxResults with more pages remaining, and exactly-at-cap
  // pages with no further results are not truncated.
  if (res.data.nextPageToken) {
    acc.errors.push(
      `coach ${coach.loginEmail}: calendar window exceeded the ${MAX_WINDOW_EVENTS}-event cap — later sessions in the window may be missing briefs`
    );
  }
  const coachingEvents = filterCoachingEvents(rawEvents, config.coachingTitleFilter);
  const emailToClient = new Map<string, (typeof clients)[number]>();
  for (const c of clients) {
    emailToClient.set(c.email.toLowerCase(), c);
    for (const se of c.secondaryEmails) emailToClient.set(se.toLowerCase(), c);
  }

  const coachEmails = new Set(config.coachEmails);

  for (const event of coachingEvents) {
    if (Date.now() > deadline) {
      acc.errors.push(
        `time budget exhausted after ${acc.generated} briefs — sessions starting before the next run need the manual Generate Brief button; later ones are picked up next run`
      );
      return true;
    }

    const matchedClient = matchAttendee(event, emailToClient, coachEmails);

    // No sessionCount check here: the client query already requires a
    // synopsis-bearing session (the actual generatePrepBrief precondition),
    // and the denormalized counter can drift to 0 and wrongly suppress.
    if (!matchedClient) {
      acc.skipped++;
      continue;
    }

    const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : null;
    if (!eventStart) {
      acc.skipped++;
      continue;
    }

    // timeMin filters on event END, so a long-running or just-ended session
    // can appear with a start older than the recovery lookback — too late
    // for a brief to be worth a paid LLM call.
    if (eventStart < windowStart) {
      acc.skipped++;
      continue;
    }

    // Check if a brief was already generated for this client + date (within 1 hour)
    const hourBefore = new Date(eventStart.getTime() - 60 * 60 * 1000);
    const hourAfter = new Date(eventStart.getTime() + 60 * 60 * 1000);
    const existingBrief = await prisma.prepBrief.findFirst({
      where: {
        clientId: matchedClient.id,
        targetSessionDate: { gte: hourBefore, lte: hourAfter },
      },
    });

    if (existingBrief) {
      acc.skipped++;
      continue;
    }

    try {
      await generatePrepBrief(matchedClient.id, eventStart);
      acc.generated++;
    } catch (err) {
      console.error(`Brief generation failed for client ${matchedClient.id}:`, err);
      acc.failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      acc.errors.push(`brief for client ${matchedClient.id}: ${message}`);
    }
  }

  return false;
}

function matchAttendee(
  event: calendar_v3.Schema$Event,
  emailToClient: Map<string, { id: string; email: string }>,
  coachEmails: Set<string>
): { id: string; email: string } | null {
  const attendees = event.attendees
    ?.filter((a) => a.email && !coachEmails.has(a.email.toLowerCase()) && !a.resource)
    .map((a) => a.email!.toLowerCase()) ?? [];
  for (const email of attendees) {
    const c = emailToClient.get(email);
    if (c) return c;
  }
  return null;
}
