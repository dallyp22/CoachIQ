import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
} from "@/lib/google-calendar";

/**
 * GET /api/calendar/events — fetch calendar events enriched with client matches.
 *
 * Query params:
 *   date=YYYY-MM-DD   — fetch events for a specific day (default: today)
 *   timeMin=ISO        — custom start time
 *   timeMax=ISO        — custom end time
 */
export async function GET(request: NextRequest) {
  try {
    const settings = await prisma.coachSettings.findFirst();
    const calendarId = settings?.googleCalendarId;

    if (!calendarId) {
      return NextResponse.json(
        { error: "Google Calendar ID not configured" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");
    const timeMinParam = searchParams.get("timeMin");
    const timeMaxParam = searchParams.get("timeMax");

    let timeMin: Date;
    let timeMax: Date;

    if (timeMinParam && timeMaxParam) {
      timeMin = new Date(timeMinParam);
      timeMax = new Date(timeMaxParam);
    } else {
      // Default to the specified date (or today) in Central Time
      const targetDate = dateParam || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      timeMin = new Date(`${targetDate}T00:00:00`);
      timeMax = new Date(`${targetDate}T23:59:59`);
    }

    const calendar = getCalendar();
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });

    const rawEvents = res.data.items || [];
    const coachingEvents = filterCoachingEvents(
      rawEvents,
      settings.coachingTitleFilter
    );

    // Load all clients for attendee matching
    const clients = await prisma.client.findMany({
      where: { status: { not: "CHURNED" } },
      select: {
        id: true,
        name: true,
        email: true,
        secondaryEmails: true,
        company: true,
        allowsFathom: true,
      },
    });

    // Build email → client lookup
    const emailToClient = new Map<string, typeof clients[number]>();
    for (const client of clients) {
      emailToClient.set(client.email.toLowerCase(), client);
      for (const se of client.secondaryEmails) {
        emailToClient.set(se.toLowerCase(), client);
      }
    }

    const coachEmail = settings.coachEmail?.toLowerCase() || "";

    // Check which calendar events already have sessions
    const eventIds = coachingEvents
      .map((e) => e.id)
      .filter(Boolean) as string[];
    const existingSessions = eventIds.length
      ? await prisma.session.findMany({
          where: { calendarEventId: { in: eventIds } },
          select: { calendarEventId: true },
        })
      : [];
    const linkedEventIds = new Set(
      existingSessions.map((s) => s.calendarEventId)
    );

    // Enrich events
    const enrichedEvents = coachingEvents.map((event) => {
      const attendeeEmails =
        event.attendees
          ?.filter(
            (a) =>
              a.email &&
              a.email.toLowerCase() !== coachEmail &&
              !a.resource
          )
          .map((a) => a.email!.toLowerCase()) ?? [];

      // Find matching client
      let matchedClient: typeof clients[number] | null = null;
      for (const email of attendeeEmails) {
        const c = emailToClient.get(email);
        if (c) {
          matchedClient = c;
          break;
        }
      }

      return {
        eventId: event.id,
        title: event.summary || "Untitled",
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        durationMinutes: eventDurationMinutes(event),
        client: matchedClient
          ? {
              id: matchedClient.id,
              name: matchedClient.name,
              company: matchedClient.company,
              allowsFathom: matchedClient.allowsFathom,
            }
          : null,
        hasSession: event.id ? linkedEventIds.has(event.id) : false,
        attendeeEmails,
      };
    });

    return NextResponse.json({
      date: dateParam || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }),
      total: enrichedEvents.length,
      events: enrichedEvents,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
