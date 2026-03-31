import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getOpenAIKey } from "@/lib/ai";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
  hasCalendarCredentials,
} from "@/lib/google-calendar";

/**
 * GET /api/daily-brief — generate today's morning brief.
 */
export async function GET() {
  try {

    const settings = await prisma.coachSettings.findFirst();
    if (!settings?.googleCalendarId || !hasCalendarCredentials()) {
      return NextResponse.json(
        { error: "Google Calendar not configured" },
        { status: 400 }
      );
    }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const todayStart = new Date(`${today}T00:00:00`);
    const todayEnd = new Date(`${today}T23:59:59`);

    // Fetch today's coaching events
    const calendar = getCalendar();
    const res = await calendar.events.list({
      calendarId: settings.googleCalendarId,
      timeMin: todayStart.toISOString(),
      timeMax: todayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });

    const rawEvents = res.data.items || [];
    const coachingEvents = filterCoachingEvents(rawEvents, settings.coachingTitleFilter);

    if (coachingEvents.length === 0) {
      return NextResponse.json({
        status: "no_sessions",
        date: today,
        brief: "No coaching sessions scheduled today. Use this time for client outreach, session reviews, or business development.",
        sessions: [],
      });
    }

    // Match events to clients
    const clients = await prisma.client.findMany({
      where: { status: { not: "CHURNED" } },
      select: {
        id: true,
        name: true,
        email: true,
        secondaryEmails: true,
        company: true,
        meetingCadence: true,
        sessionCount: true,
      },
    });
    const emailToClient = new Map<string, (typeof clients)[number]>();
    for (const c of clients) {
      emailToClient.set(c.email.toLowerCase(), c);
      for (const se of c.secondaryEmails) emailToClient.set(se.toLowerCase(), c);
    }

    const coachEmail = settings.coachEmail?.toLowerCase() || "";

    interface SessionContext {
      time: string;
      clientName: string;
      company: string | null;
      durationMinutes: number;
      lastSynopsis: string | null;
      openActionItems: string[];
      sessionCount: number;
      meetingCadence: string;
    }

    const sessionContexts: SessionContext[] = [];

    for (const event of coachingEvents) {
      const attendees = event.attendees
        ?.filter((a) => a.email && a.email.toLowerCase() !== coachEmail && !a.resource)
        .map((a) => a.email!.toLowerCase()) ?? [];

      let matchedClient: (typeof clients)[number] | null = null;
      for (const email of attendees) {
        const c = emailToClient.get(email);
        if (c) { matchedClient = c; break; }
      }

      const startTime = event.start?.dateTime
        ? new Date(event.start.dateTime).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Chicago",
          })
        : "TBD";

      let lastSynopsis: string | null = null;
      let openActionItems: string[] = [];

      if (matchedClient) {
        const lastSession = await prisma.session.findFirst({
          where: { clientId: matchedClient.id },
          orderBy: { date: "desc" },
          select: { synopsis: true, actionItems: true },
        });
        if (lastSession?.synopsis) {
          lastSynopsis = lastSession.synopsis.length > 200
            ? lastSession.synopsis.slice(0, 197) + "..."
            : lastSession.synopsis;
        }
        if (lastSession?.actionItems) {
          const items = lastSession.actionItems as Array<{ description?: string }>;
          openActionItems = items
            .filter((a) => a.description)
            .map((a) => a.description!)
            .slice(0, 3);
        }
      }

      sessionContexts.push({
        time: startTime,
        clientName: matchedClient?.name || event.summary || "Unknown",
        company: matchedClient?.company || null,
        durationMinutes: eventDurationMinutes(event),
        lastSynopsis,
        openActionItems,
        sessionCount: matchedClient?.sessionCount || 0,
        meetingCadence: matchedClient?.meetingCadence || "UNKNOWN",
      });
    }

    // Generate AI morning brief
    const apiKey = await getOpenAIKey();
    const scheduleText = sessionContexts
      .map((s) => {
        let ctx = `${s.time} — ${s.clientName}`;
        if (s.company) ctx += ` (${s.company})`;
        ctx += ` [${s.durationMinutes} min, ${s.sessionCount} sessions total, ${s.meetingCadence.toLowerCase()} cadence]`;
        if (s.lastSynopsis) ctx += `\n  Last session: ${s.lastSynopsis}`;
        if (s.openActionItems.length > 0) {
          ctx += `\n  Open action items: ${s.openActionItems.join("; ")}`;
        }
        return ctx;
      })
      .join("\n\n");

    const totalBillableHrs = sessionContexts.reduce(
      (sum, s) => sum + Math.ceil(s.durationMinutes / 15) * 0.25,
      0
    );

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a coaching intelligence assistant generating a start-of-day briefing for executive coach Todd Zimbelman. Create a concise morning overview that helps Todd start his coaching day fully informed.

Format:
**Today's Schedule** — Quick overview of timing and any gaps/back-to-back warnings
**Per-Client Context** — For each session, 2-3 sentences: what to remember, what to follow up on, suggested opening question
**Day Summary** — Total billable hours expected, any notable patterns across today's clients

Write in second person. Be specific and actionable. Use clients' first names. Keep total under 400 words.`,
          },
          {
            role: "user",
            content: `Date: ${today}
Sessions today: ${sessionContexts.length}
Expected billable hours: ${totalBillableHrs.toFixed(1)}

SCHEDULE:
${scheduleText}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!aiResp.ok) {
      const err = await aiResp.text();
      throw new Error(`OpenAI error ${aiResp.status}: ${err.slice(0, 200)}`);
    }

    const data = await aiResp.json();
    const briefContent = data.choices[0].message.content.trim();

    return NextResponse.json({
      status: "generated",
      date: today,
      brief: briefContent,
      sessions: sessionContexts.map((s) => ({
        time: s.time,
        clientName: s.clientName,
        company: s.company,
        durationMinutes: s.durationMinutes,
      })),
      totalBillableHrs,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Daily brief error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
