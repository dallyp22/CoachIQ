import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
} from "@/lib/google-calendar";
import type { calendar_v3 } from "googleapis";

interface SyncResult {
  created: number;
  linked: number;
  skipped: number;
  errors: string[];
}

/**
 * Sync calendar events into CoachIQ sessions.
 *
 * For allowsFathom=false clients: creates Session + TimeEntry from calendar events.
 * For allowsFathom=true clients with past events: links calendarEventId to existing Fathom sessions.
 */
export async function syncCalendarSessions(
  timeMin: Date,
  timeMax: Date
): Promise<SyncResult> {
  const result: SyncResult = { created: 0, linked: 0, skipped: 0, errors: [] };

  const settings = await prisma.coachSettings.findFirst();
  if (!settings?.googleCalendarId || !settings.calendarSyncEnabled) {
    return result;
  }

  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: settings.googleCalendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const rawEvents = res.data.items || [];
  const coachingEvents = filterCoachingEvents(
    rawEvents,
    settings.coachingTitleFilter
  );

  // Load clients for matching
  const clients = await prisma.client.findMany({
    where: { status: { not: "CHURNED" } },
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

  const coachEmail = settings.coachEmail?.toLowerCase() || "";

  for (const event of coachingEvents) {
    try {
      await processEvent(event, emailToClient, coachEmail, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`Event "${event.summary}": ${msg}`);
    }
  }

  return result;
}

async function processEvent(
  event: calendar_v3.Schema$Event,
  emailToClient: Map<string, { id: string; name: string; email: string; hourlyRate: unknown; allowsFathom: boolean }>,
  coachEmail: string,
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
      ?.filter((a) => a.email && a.email.toLowerCase() !== coachEmail && !a.resource)
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
