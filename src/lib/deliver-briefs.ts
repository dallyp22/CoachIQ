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
// starting before 12:00 UTC weekdays (before 7am CDT / 6am CST) and
// weekend sessions (cron is weekdays-only) get no auto-brief — the manual
// Generate Brief button covers those.
const CRON_GAP_LOOKAHEAD_MINUTES = 6 * 60 + 30;

// Upper bound on calendar events fetched per window. A 6.5h window for a
// solo coach tops out well under this; events past the cap would silently
// get no brief.
const MAX_WINDOW_EVENTS = 25;

/**
 * Generate prep briefs for sessions starting within the lookahead window —
 * max(briefDeliveryMinutes, CRON_GAP_LOOKAHEAD_MINUTES), so each run
 * pre-generates briefs for every session before the next scheduled run.
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
  const windowEnd = new Date(now.getTime() + lookaheadMinutes * 60 * 1000);

  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: settings.googleCalendarId,
    timeMin: now.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: MAX_WINDOW_EVENTS,
  });

  const rawEvents = res.data.items || [];
  const errors: string[] = [];
  if (rawEvents.length === MAX_WINDOW_EVENTS) {
    errors.push(
      `calendar window returned ${MAX_WINDOW_EVENTS} events (the cap) — later sessions in the window may be missing briefs`
    );
  }
  const coachingEvents = filterCoachingEvents(rawEvents, settings.coachingTitleFilter);

  // Load clients for attendee matching
  const clients = await prisma.client.findMany({
    where: { status: { not: "CHURNED" } },
    select: { id: true, email: true, secondaryEmails: true, sessionCount: true },
  });
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
        `time budget exhausted after ${generated} briefs — remaining sessions deferred to the next run or the manual button`
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

    if (!matchedClient || matchedClient.sessionCount === 0) {
      skipped++;
      continue;
    }

    const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : null;
    if (!eventStart) { skipped++; continue; }

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
