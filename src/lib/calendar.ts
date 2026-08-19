import { prisma } from "@/lib/db";
import { resolveCoachConfig, clientWhere } from "@/lib/authz";
import {
  getUpcomingEvents,
  filterScheduleEvents,
  eventDurationMinutes,
  hasCalendarCredentials,
} from "@/lib/google-calendar";

/**
 * A coach's upcoming coaching meetings, read from their Google Calendar. Reuses
 * the display filter (filterScheduleEvents) so an event shows if its title
 * matches the coaching filter OR a known client is on the invite — the same
 * wider net the Meetings page uses. Scoped to ONE concrete coach (their own
 * calendar + clients); the caller resolves whose.
 */

export interface UpcomingMeeting {
  title: string;
  start: string | null;
  end: string | null;
  durationMinutes: number;
  client: { id: string; name: string; company: string | null } | null;
  otherAttendees: string[];
}

export type UpcomingMeetingsResult =
  | { status: "no_calendar" }
  | { status: "ok"; horizonHours: number; count: number; meetings: UpcomingMeeting[] };

export async function listUpcomingMeetings(
  coachId: string,
  hoursAhead: number
): Promise<UpcomingMeetingsResult> {
  const settings = await prisma.coachSettings.findFirst();
  const coach = await prisma.coach.findUnique({
    where: { id: coachId },
    select: {
      coachingTitleFilter: true,
      googleCalendarId: true,
      calendarSyncEnabled: true,
      defaultHourlyRate: true,
      loginEmail: true,
      workEmails: true,
    },
  });
  const config = coach ? resolveCoachConfig(coach, settings) : null;
  if (!config?.googleCalendarId || !hasCalendarCredentials()) {
    return { status: "no_calendar" };
  }

  const rawEvents = await getUpcomingEvents(config.googleCalendarId, hoursAhead);

  const clients = await prisma.client.findMany({
    where: { status: { not: "CHURNED" }, ...clientWhere(coachId) },
    select: { id: true, name: true, email: true, secondaryEmails: true, company: true },
  });
  const emailToClient = new Map<string, (typeof clients)[number]>();
  for (const c of clients) {
    emailToClient.set(c.email.toLowerCase(), c);
    for (const se of c.secondaryEmails) emailToClient.set(se.toLowerCase(), c);
  }

  const coachEmails = new Set(config.coachEmails);
  const coachingEvents = filterScheduleEvents(
    rawEvents,
    config.coachingTitleFilter,
    coachEmails,
    new Set(emailToClient.keys())
  );

  const meetings: UpcomingMeeting[] = coachingEvents.map((event) => {
    const otherAttendees =
      event.attendees
        ?.filter((a) => a.email && !coachEmails.has(a.email.toLowerCase()) && !a.resource)
        .map((a) => a.email!.toLowerCase()) ?? [];

    let matchedClient: (typeof clients)[number] | null = null;
    for (const email of otherAttendees) {
      const c = emailToClient.get(email);
      if (c) {
        matchedClient = c;
        break;
      }
    }

    return {
      title: event.summary || "Untitled",
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      durationMinutes: eventDurationMinutes(event),
      client: matchedClient
        ? { id: matchedClient.id, name: matchedClient.name, company: matchedClient.company }
        : null,
      otherAttendees,
    };
  });

  return { status: "ok", horizonHours: hoursAhead, count: meetings.length, meetings };
}
