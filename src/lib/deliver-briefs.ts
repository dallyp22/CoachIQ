import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  hasCalendarCredentials,
} from "@/lib/google-calendar";
import { generatePrepBrief } from "@/lib/prep-brief";

export interface DeliverBriefsResult {
  status: "skipped" | "completed";
  reason?: string;
  generated?: number;
  skipped?: number;
  failed?: number;
  errors?: string[];
}

// Stop generating briefs before Vercel kills the function (maxDuration 300s
// on the workday-sync route). Remaining sessions are reported in errors
// rather than silently lost.
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

// Upper bound on calendar events fetched per window. A 6.5h window for a
// solo coach tops out well under this; events past the cap would silently
// get no brief.
const MAX_WINDOW_EVENTS = 25;

// Look back one hour so a failed or killed prior run can be re-covered:
// Vercel crons never retry, so without this a transient 12:00 failure
// permanently dropped every brief before the 18:00 run. The ±1h
// existing-brief dedup makes re-coverage idempotent, and a brief seconds
// into a session is still useful; sessions older than this get no brief
// (manual button only) rather than a paid LLM call nobody will read.
const RECOVERY_LOOKBACK_MINUTES = 60;

/**
 * Generate prep briefs for sessions starting within the lookahead window —
 * max(briefDeliveryMinutes, CRON_GAP_LOOKAHEAD_MINUTES), so each run
 * pre-generates briefs for every session before the next scheduled run.
 * The window also reaches RECOVERY_LOOKBACK_MINUTES into the past so a
 * failed prior run is partially re-covered instead of dropped.
 * Sequential re-runs are idempotent via the existing-brief check (same
 * client + session date within 1 hour); concurrent calls are not guarded.
 */
export async function deliverDueBriefs(): Promise<DeliverBriefsResult> {
  const settings = await prisma.coachSettings.findFirst();
  if (!settings?.googleCalendarId || !hasCalendarCredentials()) {
    return { status: "skipped", reason: "Calendar not configured" };
  }

  const now = new Date();
  // briefDeliveryMinutes acts as a floor if it's ever set higher than the
  // cron-gap lookahead. Window overlap between runs is harmless — the
  // existing-brief check dedupes.
  const lookaheadMinutes = Math.max(
    settings.briefDeliveryMinutes || 30,
    CRON_GAP_LOOKAHEAD_MINUTES
  );
  const windowStart = new Date(
    now.getTime() - RECOVERY_LOOKBACK_MINUTES * 60 * 1000
  );
  const windowEnd = new Date(now.getTime() + lookaheadMinutes * 60 * 1000);

  const calendar = getCalendar();
  // The calendar fetch and the client load are independent — overlap the
  // external API round-trip with the Neon query.
  const [res, clients] = await Promise.all([
    calendar.events.list({
      calendarId: settings.googleCalendarId,
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: MAX_WINDOW_EVENTS,
    }),
    // Clients for attendee matching. Only clients with at least one
    // synopsis-bearing session can actually get a brief — generatePrepBrief
    // throws without one, and a calendar-only client (sessions synced but
    // never recorded) would otherwise fail and retry on every run forever,
    // reporting eternal "partial" runs.
    prisma.client.findMany({
      where: {
        status: { not: "CHURNED" },
        sessions: { some: { synopsis: { not: null } } },
      },
      select: { id: true, email: true, secondaryEmails: true },
    }),
  ]);

  const rawEvents = res.data.items || [];
  const errors: string[] = [];
  // nextPageToken is the authoritative truncation signal — a page can come
  // back shorter than maxResults with more pages remaining, and exactly-at-cap
  // pages with no further results are not truncated.
  if (res.data.nextPageToken) {
    errors.push(
      `calendar window exceeded the ${MAX_WINDOW_EVENTS}-event cap — later sessions in the window may be missing briefs`
    );
  }
  const coachingEvents = filterCoachingEvents(rawEvents, settings.coachingTitleFilter);
  const emailToClient = new Map<string, (typeof clients)[number]>();
  for (const c of clients) {
    emailToClient.set(c.email.toLowerCase(), c);
    for (const se of c.secondaryEmails) emailToClient.set(se.toLowerCase(), c);
  }

  const coachEmail = settings.coachEmail?.toLowerCase() || "";
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (const event of coachingEvents) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      errors.push(
        `time budget exhausted after ${generated} briefs — sessions starting before the next run need the manual Generate Brief button; later ones are picked up next run`
      );
      break;
    }

    const attendees = event.attendees
      ?.filter((a) => a.email && a.email.toLowerCase() !== coachEmail && !a.resource)
      .map((a) => a.email!.toLowerCase()) ?? [];

    let matchedClient: (typeof clients)[number] | null = null;
    for (const email of attendees) {
      const c = emailToClient.get(email);
      if (c) { matchedClient = c; break; }
    }

    // No sessionCount check here: the client query already requires a
    // synopsis-bearing session (the actual generatePrepBrief precondition),
    // and the denormalized counter can drift to 0 and wrongly suppress.
    if (!matchedClient) {
      skipped++;
      continue;
    }

    const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : null;
    if (!eventStart) { skipped++; continue; }

    // timeMin filters on event END, so a long-running or just-ended session
    // can appear with a start older than the recovery lookback — too late
    // for a brief to be worth a paid LLM call.
    if (eventStart < windowStart) { skipped++; continue; }

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
      skipped++;
      continue;
    }

    try {
      await generatePrepBrief(matchedClient.id, eventStart);
      generated++;
    } catch (err) {
      console.error(`Brief generation failed for client ${matchedClient.id}:`, err);
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      errors.push(`brief for client ${matchedClient.id}: ${message}`);
    }
  }

  return { status: "completed", generated, skipped, failed, errors };
}
