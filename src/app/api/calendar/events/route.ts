import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
} from "@/lib/google-calendar";

/**
 * GET /api/calendar/events — fetch calendar events enriched with client context.
 *
 * Query params:
 *   date=YYYY-MM-DD   — fetch events for a specific day (default: today)
 *   timeMin=ISO        — custom range start
 *   timeMax=ISO        — custom range end
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
      maxResults: 100,
    });

    const rawEvents = res.data.items || [];
    const coachingEvents = filterCoachingEvents(rawEvents, settings.coachingTitleFilter);

    // Load clients
    const clients = await prisma.client.findMany({
      where: { status: { not: "CHURNED" } },
      select: {
        id: true,
        name: true,
        email: true,
        secondaryEmails: true,
        company: true,
        allowsFathom: true,
        sessionCount: true,
        meetingCadence: true,
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

    // Enrich events with full context
    const enrichedEvents = await Promise.all(
      coachingEvents.map(async (event) => {
        const attendeeEmails =
          event.attendees
            ?.filter((a) => a.email && a.email.toLowerCase() !== coachEmail && !a.resource)
            .map((a) => a.email!.toLowerCase()) ?? [];

        let matchedClient: (typeof clients)[number] | null = null;
        for (const email of attendeeEmails) {
          const c = emailToClient.get(email);
          if (c) { matchedClient = c; break; }
        }

        // Fetch last session context for the client
        let lastSynopsis: string | null = null;
        let actionItems: Array<{ description?: string }> = [];
        if (matchedClient) {
          const lastSession = await prisma.session.findFirst({
            where: { clientId: matchedClient.id },
            orderBy: { date: "desc" },
            select: { synopsis: true, actionItems: true },
          });
          if (lastSession?.synopsis) {
            lastSynopsis = lastSession.synopsis;
          }
          if (lastSession?.actionItems) {
            actionItems = (lastSession.actionItems as Array<{ description?: string }>)
              .filter((a) => a.description)
              .slice(0, 5);
          }
        }

        // Check for existing prep brief
        let briefContent: string | null = null;
        let briefId: string | null = null;
        if (matchedClient) {
          const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : null;
          if (eventStart) {
            const hourBefore = new Date(eventStart.getTime() - 60 * 60 * 1000);
            const hourAfter = new Date(eventStart.getTime() + 60 * 60 * 1000);
            const brief = await prisma.prepBrief.findFirst({
              where: {
                clientId: matchedClient.id,
                targetSessionDate: { gte: hourBefore, lte: hourAfter },
              },
              orderBy: { createdAt: "desc" },
              select: { id: true, content: true },
            });
            if (brief) {
              briefId = brief.id;
              briefContent = brief.content;
            }
          }
        }

        // First sentence of synopsis for collapsed view
        let synopsisPreview: string | null = null;
        if (lastSynopsis) {
          const firstSentence = lastSynopsis.split(/[.!?]\s/)[0];
          synopsisPreview = firstSentence.length < 150
            ? firstSentence + "."
            : firstSentence.slice(0, 147) + "...";
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
                sessionCount: matchedClient.sessionCount,
                meetingCadence: matchedClient.meetingCadence,
              }
            : null,
          synopsisPreview,
          lastSynopsis,
          actionItems,
          briefId,
          briefContent,
        };
      })
    );

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
