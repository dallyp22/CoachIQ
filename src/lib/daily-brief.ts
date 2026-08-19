import { prisma } from "@/lib/db";
import { getChatProvider } from "@/lib/ai";
import { resolveCoachConfig, clientWhere, viaClientWhere } from "@/lib/authz";
import {
  getCalendar,
  filterCoachingEvents,
  eventDurationMinutes,
  hasCalendarCredentials,
} from "@/lib/google-calendar";

/**
 * The start-of-day brief assembly, extracted from /api/daily-brief so the MCP
 * get_daily_brief tool produces the identical brief. Takes a CONCRETE coach id
 * (the day belongs to one coach — the caller resolves whose, and a COACH is
 * always their own). Returns a discriminated result the caller maps to HTTP or
 * an MCP tool result; throws only on genuine failures (calendar/AI errors).
 */

export interface DailyBriefStructured {
  schedule: { time: string; description: string }[];
  scheduleNote: string | null;
  summary: string;
  perClient: {
    name: string;
    context: string;
    openingQuestion: string | null;
    actionItems: string[];
  }[];
}

export interface DailyBriefSession {
  time: string;
  clientName: string;
  company: string | null;
  durationMinutes: number;
  status: "new" | "ongoing" | "unknown";
}

export type DailyBriefResult =
  | { status: "no_calendar" }
  | { status: "no_sessions"; date: string; brief: DailyBriefStructured; sessions: [] }
  | {
      status: "generated";
      date: string;
      brief: DailyBriefStructured;
      sessions: DailyBriefSession[];
      totalBillableHrs: number;
    };

export async function buildDailyBrief(briefCoachId: string): Promise<DailyBriefResult> {
  const settings = await prisma.coachSettings.findFirst();
  const briefCoach = await prisma.coach.findUnique({
    where: { id: briefCoachId },
    select: {
      id: true,
      name: true,
      loginEmail: true,
      workEmails: true,
      googleCalendarId: true,
      coachingTitleFilter: true,
      calendarSyncEnabled: true,
      defaultHourlyRate: true,
    },
  });
  const coachName = briefCoach?.name?.trim() || "the coach";
  const config = briefCoach ? resolveCoachConfig(briefCoach, settings) : null;
  if (!config?.googleCalendarId || !hasCalendarCredentials()) {
    return { status: "no_calendar" };
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const todayStart = new Date(`${today}T00:00:00`);
  const todayEnd = new Date(`${today}T23:59:59`);

  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: config.googleCalendarId,
    timeMin: todayStart.toISOString(),
    timeMax: todayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const rawEvents = res.data.items || [];
  const coachingEvents = filterCoachingEvents(rawEvents, config.coachingTitleFilter);

  if (coachingEvents.length === 0) {
    return {
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
    };
  }

  const clients = await prisma.client.findMany({
    where: { status: { not: "CHURNED" }, ...clientWhere(briefCoachId) },
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

  const coachEmails = new Set(config.coachEmails);

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
    unmatchedEmail: string | null;
  }

  const sessionContexts: SessionContext[] = [];

  for (const event of coachingEvents) {
    const attendees =
      event.attendees
        ?.filter((a) => a.email && !coachEmails.has(a.email.toLowerCase()) && !a.resource)
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
        where: { clientId: matchedClient.id, ...viaClientWhere(briefCoachId) },
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
        const items = lastSession.actionItems as Array<{ description?: string }>;
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

  const briefSchema = {
    type: "object",
    properties: {
      schedule: {
        type: "array",
        items: {
          type: "object",
          properties: {
            time: { type: "string" },
            description: { type: "string" },
          },
          required: ["time", "description"],
        },
      },
      scheduleNote: {
        type: ["string", "null"],
        description:
          "One-line callout about back-to-back blocks, awkward gaps, or unusual density. Null if nothing notable.",
      },
      perClient: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "First name of the client." },
            context: {
              type: "string",
              description:
                "2-3 sentences of what to remember and what to follow up on, drawn from lastSynopsis and openActionItems. Reference specifics, not generalities.",
            },
            openingQuestion: {
              type: ["string", "null"],
              description:
                "A single suggested opening question framed for this session. Null only if status === 'unknown'.",
            },
          },
          required: ["name", "context", "openingQuestion"],
        },
      },
      summary: {
        type: "string",
        description:
          "1-2 sentences on the day's tone — total billable hours, notable patterns, anything the coach should mentally prepare for.",
      },
    },
    required: ["schedule", "scheduleNote", "perClient", "summary"],
  } as const;

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
      max_tokens: 1200,
      tools: [
        {
          type: "function",
          function: {
            name: "render_day_brief",
            description:
              "Render the structured day brief. Always call this exactly once with the complete brief.",
            parameters: briefSchema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "render_day_brief" } },
      messages: [
        {
          role: "system",
          content: `You generate a start-of-day briefing for executive coach ${coachName}. Call the render_day_brief tool exactly once with the complete brief. Write in second person, use clients' first names, be specific and actionable. Total content under 350 words.

For each session, mirror it once in "schedule" (one-line: who/duration/title-style label) and once in "perClient":
  - context: 2-3 sentences of what to remember and what to follow up on, drawn from lastSynopsis and openActionItems. Reference specifics, not generalities.
  - openingQuestion: a single suggested opening question, framed for THIS session. Null only if status === "unknown".

CRITICAL — session history rules:
  - status="new" (priorSessions === 0, matched client): brand-new client, rapport-building framing is appropriate.
  - status="ongoing" (priorSessions > 0): the client has history. NEVER say "first session," "first meeting," "establishing rapport," or anything implying a new relationship. Reference the lastSynopsis specifically. The opening question should pick up the existing thread.
  - status="unknown" (no match found): we couldn't match the calendar attendee to a registered client. Say so honestly in context — e.g. "I don't have history on this attendee — open with a check-in." openingQuestion: null. Do not invent prior context.

scheduleNote: a single short callout about back-to-back blocks, awkward gaps, or unusual density. Null if nothing notable.

summary: 1-2 sentences on the day's tone — total billable hours, notable patterns, anything ${coachName} should mentally prepare for.`,
        },
        {
          role: "user",
          content: JSON.stringify({ ...userPayload, expectedBillableHours: totalBillableHrs }),
        },
      ],
    }),
  });

  if (!aiResp.ok) {
    const err = await aiResp.text();
    throw new Error(
      `Chat API error ${aiResp.status} (model=${provider.defaultModel}): ${err.slice(0, 400)}`
    );
  }

  const data = await aiResp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    const fallback = data.choices?.[0]?.message?.content ?? "";
    throw new Error(
      `Model did not return a tool call (model=${provider.defaultModel}). content="${String(fallback).slice(0, 200)}"`
    );
  }

  let aiBrief: {
    schedule: { time: string; description: string }[];
    scheduleNote: string | null;
    perClient: { name: string; context: string; openingQuestion: string | null }[];
    summary: string;
  };
  try {
    aiBrief = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    throw new Error(
      `Tool call arguments were not valid JSON (model=${provider.defaultModel}): ${String(e).slice(0, 200)}`
    );
  }

  const itemsByFirstName = new Map<string, string[]>();
  const itemsByFullName = new Map<string, string[]>();
  for (const s of sessionContexts) {
    if (!s.openActionItems.length) continue;
    const first = s.clientName.trim().split(/\s+/)[0]?.toLowerCase();
    if (first && !itemsByFirstName.has(first)) {
      itemsByFirstName.set(first, s.openActionItems);
    }
    itemsByFullName.set(s.clientName.trim().toLowerCase(), s.openActionItems);
  }

  const briefStructured: DailyBriefStructured = {
    schedule: aiBrief.schedule,
    scheduleNote: aiBrief.scheduleNote,
    summary: aiBrief.summary,
    perClient: aiBrief.perClient.map((p) => {
      const first = p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const full = p.name.trim().toLowerCase();
      return {
        ...p,
        actionItems: itemsByFullName.get(full) ?? itemsByFirstName.get(first) ?? [],
      };
    }),
  };

  const unmatched = sessionContexts.filter((s) => s.status === "unknown");
  if (unmatched.length) {
    console.warn(
      "[daily-brief] unmatched attendees — add to client secondaryEmails:",
      unmatched.map((s) => `${s.clientName} <${s.unmatchedEmail ?? "no-email"}>`)
    );
  }

  return {
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
  };
}
