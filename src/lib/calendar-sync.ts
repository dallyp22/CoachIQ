import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
} from "@/lib/google-calendar";
import { resolveCoachConfig } from "@/lib/authz";
import type { calendar_v3 } from "googleapis";

interface SyncResult {
  created: number;
  linked: number;
  skipped: number;
  errors: string[];
}

// The columns resolveCoachConfig needs, plus the id to scope clients by.
const COACH_SYNC_SELECT = {
  id: true,
  loginEmail: true,
  workEmails: true,
  googleCalendarId: true,
  coachingTitleFilter: true,
  calendarSyncEnabled: true,
  defaultHourlyRate: true,
} as const;

/**
 * Sync calendar events into CoachIQ sessions, one coach at a time.
 *
 * Each coach has their own calendar and their own book of clients. A coach's
 * calendar is matched ONLY against that coach's clients — matching against every
 * client would let Coach A's meeting mint a Session + billable TimeEntry on
 * Coach B's client (the same person can be a client of two coaches with two
 * separate rows). The per-coach client scope below is the tenant boundary.
 *
 * For allowsFathom=false clients: creates Session + TimeEntry from calendar events.
 * For allowsFathom=true clients with past events: links calendarEventId to existing Fathom sessions.
 */
export async function syncCalendarSessions(
  timeMin: Date,
  timeMax: Date,
  // Absolute Date.now() past which no further COACH is started, so the calendar
  // phase leaves room for brief delivery inside the cron's 300s. Omitted by the
  // manual sync route, which has no such shared budget.
  deadline?: number
): Promise<SyncResult> {
  const result: SyncResult = { created: 0, linked: 0, skipped: 0, errors: [] };

  const settings = await prisma.coachSettings.findFirst();
  // A coach with no calendar id can't be synced; skip them at the query so an
  // unconfigured coach never even resolves. calendarSyncEnabled is a per-coach
  // boolean checked below (false is a real "off", not a missing value).
  // Deterministic order (owner first) so which coach a budget cutoff strands is
  // predictable, not DB-order roulette.
  const coaches = await prisma.coach.findMany({
    where: { status: { not: "INACTIVE" }, googleCalendarId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: COACH_SYNC_SELECT,
  });

  for (const coach of coaches) {
    if (deadline !== undefined && Date.now() > deadline) {
      result.errors.push(
        `time budget reached before coach ${coach.loginEmail} — remaining coaches deferred to the next run`
      );
      break;
    }
    try {
      await syncCoachCalendar(coach, settings, timeMin, timeMax, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`coach ${coach.loginEmail}: ${msg}`);
    }
  }

  return result;
}

type SyncCoach = {
  id: string;
  loginEmail: string;
  workEmails: string[];
  googleCalendarId: string | null;
  coachingTitleFilter: string | null;
  calendarSyncEnabled: boolean;
  defaultHourlyRate: unknown;
};

async function syncCoachCalendar(
  coach: SyncCoach,
  settings: Parameters<typeof resolveCoachConfig>[1],
  timeMin: Date,
  timeMax: Date,
  result: SyncResult
) {
  const config = resolveCoachConfig(coach, settings);
  if (!config.googleCalendarId || !config.calendarSyncEnabled) {
    return;
  }

  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: config.googleCalendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const rawEvents = res.data.items || [];
  const coachingEvents = filterCoachingEvents(rawEvents, config.coachingTitleFilter);

  // Load ONLY this coach's clients for matching — the tenant boundary.
  const clients = await prisma.client.findMany({
    where: { coachId: coach.id, status: { not: "CHURNED" } },
    select: {
      id: true,
      name: true,
      email: true,
      secondaryEmails: true,
      hourlyRate: true,
      allowsFathom: true,
    },
  });

  const emailToClient = new Map<string, (typeof clients)[number]>();
  for (const client of clients) {
    emailToClient.set(client.email.toLowerCase(), client);
    for (const se of client.secondaryEmails) {
      emailToClient.set(se.toLowerCase(), client);
    }
  }

  // Exclude every address that identifies this coach (loginEmail + workEmails),
  // so the coach themselves is never matched as an attendee/client.
  const coachEmails = new Set(config.coachEmails);

  for (const event of coachingEvents) {
    try {
      await processEvent(event, emailToClient, coachEmails, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`Event "${event.summary}": ${msg}`);
    }
  }
}

async function processEvent(
  event: calendar_v3.Schema$Event,
  emailToClient: Map<string, { id: string; name: string; email: string; hourlyRate: unknown; allowsFathom: boolean }>,
  coachEmails: Set<string>,
  result: SyncResult
) {
  const eventId = event.id;
  if (!eventId) {
    result.skipped++;
    return;
  }

  // Already linked to a session?
  const existingByCalendar = await prisma.session.findUnique({
    where: { calendarEventId: eventId },
  });
  if (existingByCalendar) {
    result.skipped++;
    return;
  }

  // Find the client from attendees
  const attendeeEmails =
    event.attendees
      ?.filter((a) => a.email && !coachEmails.has(a.email.toLowerCase()) && !a.resource)
      .map((a) => a.email!.toLowerCase()) ?? [];

  let client: (typeof emailToClient extends Map<string, infer V> ? V : never) | null = null;
  for (const email of attendeeEmails) {
    const c = emailToClient.get(email);
    if (c) {
      client = c;
      break;
    }
  }

  if (!client) {
    result.skipped++;
    return;
  }

  const eventStart = event.start?.dateTime
    ? new Date(event.start.dateTime)
    : null;
  if (!eventStart) {
    result.skipped++;
    return;
  }

  const durationMinutes = eventDurationMinutes(event);
  const now = new Date();
  const isPast = eventStart < now;

  if (client.allowsFathom) {
    // For Fathom clients, only link past events to existing sessions
    if (isPast) {
      const windowStart = new Date(eventStart.getTime() - 2 * 60 * 60 * 1000);
      const windowEnd = new Date(eventStart.getTime() + 2 * 60 * 60 * 1000);

      const existingFathomSession = await prisma.session.findFirst({
        where: {
          clientId: client.id,
          sessionSource: "FATHOM",
          calendarEventId: null,
          date: { gte: windowStart, lte: windowEnd },
        },
      });

      if (existingFathomSession) {
        await prisma.session.update({
          where: { id: existingFathomSession.id },
          data: { calendarEventId: eventId },
        });
        result.linked++;
      } else {
        result.skipped++;
      }
    } else {
      result.skipped++;
    }
    return;
  }

  // Non-Fathom client: only create sessions for past events
  if (!isPast) {
    result.skipped++;
    return;
  }

  // Create session + time entry
  const billableMinutes = Math.ceil(durationMinutes / 15) * 15;
  const billableHrs = Math.ceil(durationMinutes / 15) * 0.25;
  const hourlyRate = Number(client.hourlyRate);

  await prisma.$transaction(async (tx) => {
    await tx.session.create({
      data: {
        clientId: client!.id,
        sessionSource: "CALENDAR",
        calendarEventId: eventId,
        title: event.summary || "Coaching Session",
        date: eventStart,
        durationMinutes,
        billableMinutes,
        status: "CAPTURED",
      },
    });

    // Find the session we just created (for the auto-generated ID)
    const sess = await tx.session.findUnique({
      where: { calendarEventId: eventId },
    });

    if (sess) {
      await tx.timeEntry.create({
        data: {
          sessionId: sess.id,
          clientId: client!.id,
          date: eventStart,
          description: event.summary || "Coaching Session",
          billableHours: billableHrs,
          hourlyRate,
          amount: billableHrs * hourlyRate,
          isManual: false,
          status: "UNBILLED",
        },
      });

      await tx.client.update({
        where: { id: client!.id },
        data: { sessionCount: { increment: 1 } },
      });
    }
  });

  result.created++;
}
