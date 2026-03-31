import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getCalendar,
  filterCoachingEvents,
  hasCalendarCredentials,
} from "@/lib/google-calendar";
import { generatePrepBrief } from "@/lib/prep-brief";

/**
 * GET /api/cron/deliver-briefs — auto-generate prep briefs for upcoming sessions.
 * Runs every 5 minutes. Generates briefs for sessions within the briefDeliveryMinutes window.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settings = await prisma.coachSettings.findFirst();
    if (!settings?.googleCalendarId || !hasCalendarCredentials()) {
      return NextResponse.json({ status: "skipped", reason: "Calendar not configured" });
    }

    const deliveryMinutes = settings.briefDeliveryMinutes || 30;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + deliveryMinutes * 60 * 1000);

    const calendar = getCalendar();
    const res = await calendar.events.list({
      calendarId: settings.googleCalendarId,
      timeMin: now.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
    });

    const rawEvents = res.data.items || [];
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

    for (const event of coachingEvents) {
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
        skipped++;
      }
    }

    return NextResponse.json({
      status: "completed",
      timestamp: now.toISOString(),
      generated,
      skipped,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Deliver briefs cron failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
