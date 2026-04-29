import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getChatProvider } from "@/lib/ai";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
  hasCalendarCredentials,
} from "@/lib/google-calendar";

/**
 * GET /api/daily-brief — generate today's morning brief.
 *
 * Returns a structured object (no markdown) so the client can render brand
 * typography reliably and we don't have to parse model output.
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

    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    });
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
    const coachingEvents = filterCoachingEvents(
      rawEvents,
      settings.coachingTitleFilter
    );

    if (coachingEvents.length === 0) {
      return NextResponse.json({
        status: "no_sessions",
        date: today,
        brief: {
          schedule: [],
          scheduleNote: null,
          perClient: [],
          summary:
            "No coaching sessions scheduled today. Use this time for client outreach, session reviews, or business development.",
        },
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
      for (const se of c.secondaryEmails)
        emailToClient.set(se.toLowerCase(), c);
    }

    const coachEmail = settings.coachEmail?.toLowerCase() || "";

    interface SessionContext {
      time: string;
      clientName: string;
      company: string | null;
      durationMinutes: number;
      status: "new" | "ongoing" | "unknown";
      priorSessions: number;
      meetingCadence: string;
      lastSynopsis: string | null;
      openActionItems: string[];
      unmatchedEmail: string | null; // for diagnostics when status === "unknown"
    }

    const sessionContexts: SessionContext[] = [];

    for (const event of coachingEvents) {
      const attendees =
        event.attendees
          ?.filter(
            (a) => a.email && a.email.toLowerCase() !== coachEmail && !a.resource
          )
          .map((a) => a.email!.toLowerCase()) ?? [];

      let matchedClient: (typeof clients)[number] | null = null;
      for (const email of attendees) {
        const c = emailToClient.get(email);
        if (c) {
          matchedClient = c;
          break;
        }
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
          lastSynopsis =
            lastSession.synopsis.length > 240
              ? lastSession.synopsis.slice(0, 237) + "..."
              : lastSession.synopsis;
        }
        if (lastSession?.actionItems) {
          const items = lastSession.actionItems as Array<{
            description?: string;
          }>;
          openActionItems = items
            .filter((a) => a.description)
            .map((a) => a.description!)
            .slice(0, 3);
        }
      }

      let status: SessionContext["status"];
      if (!matchedClient) status = "unknown";
      else if (matchedClient.sessionCount === 0) status = "new";
      else status = "ongoing";

      sessionContexts.push({
        time: startTime,
        clientName: matchedClient?.name || event.summary || "Unknown",
        company: matchedClient?.company || null,
        durationMinutes: eventDurationMinutes(event),
        status,
        priorSessions: matchedClient?.sessionCount ?? 0,
        meetingCadence: matchedClient?.meetingCadence || "UNKNOWN",
        lastSynopsis,
        openActionItems,
        unmatchedEmail: matchedClient ? null : attendees[0] ?? null,
      });
    }

    // Generate AI morning brief
    const provider = await getChatProvider();

    const userPayload = {
      date: today,
      sessionsCount: sessionContexts.length,
      sessions: sessionContexts.map((s) => ({
        time: s.time,
        clientName: s.clientName,
        company: s.company,
        durationMinutes: s.durationMinutes,
        status: s.status,
        priorSessions: s.priorSessions,
        meetingCadence: s.meetingCadence.toLowerCase(),
        lastSynopsis: s.lastSynopsis,
        openActionItems: s.openActionItems,
      })),
    };

    const totalBillableHrs = sessionContexts.reduce(
      (sum, s) => sum + Math.ceil(s.durationMinutes / 15) * 0.25,
      0
    );

    const aiResp = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        ...(provider.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: provider.defaultModel,
        temperature: 0.3,
        max_tokens: 900,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "day_brief",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                schedule: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      time: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["time", "description"],
                  },
                },
                scheduleNote: { type: ["string", "null"] },
                perClient: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      context: { type: "string" },
                      openingQuestion: { type: ["string", "null"] },
                    },
                    required: ["name", "context", "openingQuestion"],
                  },
                },
                summary: { type: "string" },
              },
              required: ["schedule", "scheduleNote", "perClient", "summary"],
            },
          },
        },
        messages: [
          {
            role: "system",
            content: `You generate a start-of-day briefing for executive coach Todd Zimbelman. Return JSON matching the schema. Write in second person, use clients' first names, be specific and actionable. Total content under 350 words.

For each session, mirror it once in "schedule" (one-line: who/duration/title-style label) and once in "perClient":
  - context: 2-3 sentences of what to remember and what to follow up on, drawn from lastSynopsis and openActionItems. Reference specifics, not generalities.
  - openingQuestion: a single suggested opening question, framed for THIS session. Null only if status === "unknown".

CRITICAL — session history rules:
  - status="new" (priorSessions === 0, matched client): brand-new client, rapport-building framing is appropriate.
  - status="ongoing" (priorSessions > 0): the client has history. NEVER say "first session," "first meeting," "establishing rapport," or anything implying a new relationship. Reference the lastSynopsis specifically. The opening question should pick up the existing thread.
  - status="unknown" (no match found): we couldn't match the calendar attendee to a registered client. Say so honestly in context — e.g. "I don't have history on this attendee — open with a check-in." openingQuestion: null. Do not invent prior context.

scheduleNote: a single short callout about back-to-back blocks, awkward gaps, or unusual density. Null if nothing notable.

summary: 1-2 sentences on the day's tone — total billable hours, notable patterns, anything Todd should mentally prepare for.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              ...userPayload,
              expectedBillableHours: totalBillableHrs,
            }),
          },
        ],
      }),
    });

    if (!aiResp.ok) {
      const err = await aiResp.text();
      throw new Error(`OpenAI error ${aiResp.status}: ${err.slice(0, 200)}`);
    }

    const data = await aiResp.json();
    const briefStructured = JSON.parse(data.choices[0].message.content);

    // Surface unmatched-attendee warnings so Todd knows to add the email to
    // the client's secondaryEmails. These show up in Vercel function logs.
    const unmatched = sessionContexts.filter((s) => s.status === "unknown");
    if (unmatched.length) {
      console.warn(
        "[daily-brief] unmatched attendees — add to client secondaryEmails:",
        unmatched.map((s) => `${s.clientName} <${s.unmatchedEmail ?? "no-email"}>`)
      );
    }

    return NextResponse.json({
      status: "generated",
      date: today,
      brief: briefStructured,
      sessions: sessionContexts.map((s) => ({
        time: s.time,
        clientName: s.clientName,
        company: s.company,
        durationMinutes: s.durationMinutes,
        status: s.status,
      })),
      totalBillableHrs,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Daily brief error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
