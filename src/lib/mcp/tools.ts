import { z } from "zod";
import { startOfWeek, startOfMonth } from "date-fns";
import type { createMcpHandler } from "mcp-handler";
import { prisma } from "@/lib/db";
import {
  scopeCoachId,
  clientWhere,
  viaClientWhere,
  prospectWhere,
  canAccessProspect,
} from "@/lib/authz";
import { searchSessions } from "@/lib/search";
import { getPracticeOverview } from "@/lib/practice-stats";
import { buildDailyBrief } from "@/lib/daily-brief";
import { listUpcomingMeetings } from "@/lib/calendar";
import { createClients } from "@/lib/clients";
import {
  createProspects,
  createPipelineActivity,
  moveProspectStage,
  terminalFilterForStatus,
  daysSince,
} from "@/lib/pipeline/writes";
import { APP_VERSION } from "@/lib/version";
import { resolveMcpCoach, resolveMcpActor, jsonResult, errorResult } from "@/lib/mcp/context";

/**
 * Registers every CoachIQ MCP tool on the given server. Each tool resolves the
 * caller to a coach (resolveMcpCoach) and then reuses the same src/lib logic and
 * scoping helpers the web app uses — the multi-tenant security model is shared,
 * not re-implemented. Tools are added here incrementally by phase.
 */
/** The MCP server instance type exactly as createMcpHandler hands it to us. */
type CoachIqMcpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

export function registerCoachIqTools(server: CoachIqMcpServer) {
  // ─── search_sessions (read) ─────────────────────────────
  server.registerTool(
    "search_sessions",
    {
      description:
        "Search across coaching session transcripts and summaries. Uses semantic " +
        "(meaning-based) search with keyword fallback, plus client-name matching. " +
        "Returns the most relevant sessions with a short excerpt, client name, date, " +
        "and recording link. Scoped automatically to what the signed-in coach may see. " +
        "Use this to answer questions like 'what did I discuss with Acme about pricing' " +
        "or 'find sessions where a client mentioned burnout'.",
      inputSchema: {
        query: z.string().describe("What to search for — a topic, phrase, or client name."),
        clientId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional: narrow the search to a single client by their id."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to return (default 15, max 50)."),
      },
    },
    async ({ query, clientId, limit }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        // No query-string override on MCP: a COACH is pinned to their own id,
        // OWNER/ADMIN search the whole practice — exactly the web default.
        const coachId = scopeCoachId(coach, undefined);
        const { results, method } = await searchSessions({ coachId, query, clientId, limit });
        return jsonResult({ method, count: results.length, results });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── list_clients (read) ────────────────────────────────
  server.registerTool(
    "list_clients",
    {
      description:
        "List the coaching clients the signed-in coach can see (excludes churned " +
        "clients). Returns each client's id, name, company, status, and session count. " +
        "A COACH sees only their own clients; an OWNER/ADMIN sees the whole practice. " +
        "Use the returned id with other tools (e.g. search_sessions clientId).",
      inputSchema: {
        includeChurned: z
          .boolean()
          .optional()
          .describe("Include churned clients too (default false)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max clients to return (default 200)."),
      },
    },
    async ({ includeChurned, limit = 200 }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const coachId = scopeCoachId(coach, undefined);
        // Bounded: for an OWNER/ADMIN clientWhere is empty, so without a take
        // this would return every client in the practice in one payload.
        const clients = await prisma.client.findMany({
          where: {
            ...(includeChurned ? {} : { status: { not: "CHURNED" } }),
            ...clientWhere(coachId),
          },
          select: {
            id: true,
            name: true,
            company: true,
            status: true,
            sessionCount: true,
          },
          orderBy: { name: "asc" },
          take: limit,
        });
        return jsonResult({ count: clients.length, clients });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── get_session (read) ─────────────────────────────────
  server.registerTool(
    "get_session",
    {
      description:
        "Get the full detail of one coaching session by its id: title, date, " +
        "duration, the AI synopsis, Fathom summary, action items, recording link, " +
        "and the session transcript. Use a session id returned by search_sessions. " +
        "Only returns sessions the signed-in coach is allowed to see.",
      inputSchema: {
        sessionId: z.string().uuid().describe("The session id (from search_sessions)."),
        includeTranscript: z
          .boolean()
          .optional()
          .describe(
            "Include the full transcript text (default false — transcripts can be very " +
              "large; the synopsis and action items are always returned). Set true only " +
              "when you need the verbatim conversation."
          ),
      },
    },
    async ({ sessionId, includeTranscript = false }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const coachId = scopeCoachId(coach, undefined);
        // Scope through the client: session → client → coachId. A COACH only
        // ever reaches their own clients' sessions; 404-style empty otherwise.
        const session = await prisma.session.findFirst({
          where: { id: sessionId, ...viaClientWhere(coachId) },
          select: {
            id: true,
            title: true,
            date: true,
            durationMinutes: true,
            billableMinutes: true,
            recordingUrl: true,
            shareUrl: true,
            synopsis: true,
            fathomSummary: true,
            actionItems: true,
            status: true,
            client: { select: { id: true, name: true, company: true } },
            transcript: includeTranscript
              ? { select: { fullText: true, wordCount: true, topics: true } }
              : { select: { wordCount: true, topics: true } },
          },
        });
        if (!session) {
          return jsonResult({ found: false, message: "No such session in your scope." });
        }
        return jsonResult({ found: true, session });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── get_client (read) ──────────────────────────────────
  server.registerTool(
    "get_client",
    {
      description:
        "Get a full profile ('dossier') for one client: contact and billing " +
        "details, meeting cadence, notes, the description of need, tags, and their " +
        "20 most recent sessions (with synopsis). Use a client id from list_clients " +
        "or search_sessions. Only returns a client the signed-in coach may see.",
      inputSchema: {
        clientId: z.string().uuid().describe("The client id."),
      },
    },
    async ({ clientId }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const coachId = scopeCoachId(coach, undefined);
        // clientWhere pins the coach for a COACH; empty for OWNER/ADMIN. A row
        // outside scope simply doesn't match — no existence disclosure.
        const client = await prisma.client.findFirst({
          where: { id: clientId, ...clientWhere(coachId) },
          include: {
            billingGroup: { select: { id: true, name: true, displayName: true } },
            sessions: {
              orderBy: { date: "desc" },
              take: 20,
              select: {
                id: true,
                title: true,
                date: true,
                durationMinutes: true,
                billableMinutes: true,
                recordingUrl: true,
                synopsis: true,
                sessionSource: true,
              },
            },
          },
        });
        if (!client) {
          return jsonResult({ found: false, message: "No such client in your scope." });
        }
        return jsonResult({ found: true, client });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── list_prospects (read) ──────────────────────────────
  server.registerTool(
    "list_prospects",
    {
      description:
        "List sales-pipeline prospects (leads) the signed-in coach can see. A COACH " +
        "sees prospects they own OR are assigned; OWNER/ADMIN see the whole practice. " +
        "Filter by status: open (default), won, lost, or all. Returns each prospect's " +
        "name, company, opportunity type, current stage, days in stage, and next " +
        "scheduled activity — sorted stalest-first so neglected leads surface.",
      inputSchema: {
        status: z
          .enum(["open", "won", "lost", "all"])
          .optional()
          .describe("Which prospects to include (default 'open')."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)."),
      },
    },
    async ({ status = "open", limit = 50 }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const coachId = scopeCoachId(coach, undefined);
        const prospects = await prisma.prospect.findMany({
          where: { ...prospectWhere(coachId), ...terminalFilterForStatus(status) },
          orderBy: [{ nextActivityAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
          take: limit,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            company: true,
            opportunityType: true,
            email: true,
            stageEnteredAt: true,
            nextActivityAt: true,
            convertedToClientId: true,
            createdAt: true,
            stage: { select: { id: true, name: true, terminal: true, isHot: true } },
            coach: { select: { id: true, name: true } },
            assignedCoach: { select: { id: true, name: true } },
          },
        });
        const withDays = prospects.map((p) => ({
          ...p,
          daysInStage: Math.floor(daysSince(p.stageEnteredAt)),
        }));
        return jsonResult({ count: withDays.length, status, prospects: withDays });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── get_prospect (read) ────────────────────────────────
  server.registerTool(
    "get_prospect",
    {
      description:
        "Get one pipeline prospect in full: profile, current stage, the complete " +
        "activity log (calls, meetings, notes — logged and planned), and the stage " +
        "history. Use a prospect id from list_prospects. Only returns a prospect the " +
        "signed-in coach owns or is assigned.",
      inputSchema: {
        prospectId: z.string().uuid().describe("The prospect id."),
      },
    },
    async ({ prospectId }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const coachId = scopeCoachId(coach, undefined);
        const prospect = await prisma.prospect.findUnique({
          where: { id: prospectId },
          include: {
            stage: { select: { id: true, name: true, terminal: true, isHot: true } },
            coach: { select: { id: true, name: true } },
            assignedCoach: { select: { id: true, name: true } },
          },
        });
        // 404-not-403: confirming a prospect exists but belongs to someone else
        // is itself a disclosure (see canAccessProspect).
        if (!prospect || !canAccessProspect(coachId, prospect)) {
          return jsonResult({ found: false, message: "No such prospect in your scope." });
        }
        const [activities, stageChanges] = await Promise.all([
          prisma.pipelineActivity.findMany({
            where: { prospectId },
            orderBy: { activityAt: "desc" },
            select: {
              id: true,
              kind: true,
              activityAt: true,
              notes: true,
              completedAt: true,
              owner: { select: { id: true, name: true } },
            },
          }),
          prisma.prospectStageChange.findMany({
            where: { prospectId },
            orderBy: { changedAt: "desc" },
            select: { id: true, fromStageId: true, toStageId: true, changedAt: true },
          }),
        ]);
        return jsonResult({ found: true, prospect, activities, stageChanges });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── get_analytics (read) ───────────────────────────────
  server.registerTool(
    "get_analytics",
    {
      description:
        "Get practice health metrics. For a COACH: their own active clients, sessions " +
        "this week, billable hours this month, and unbilled dollars. For OWNER/ADMIN: " +
        "a per-coach breakdown of the same across the whole practice.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const coachId = scopeCoachId(coach, undefined);
        // OWNER/ADMIN (coachId null) get the practice-wide per-coach overview.
        if (coachId === null) {
          const overview = await getPracticeOverview();
          return jsonResult({ scope: "practice", coaches: overview });
        }
        // A COACH gets their own single-coach aggregate.
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const monthStart = startOfMonth(new Date());
        const via = viaClientWhere(coachId);
        // Sum in Postgres (aggregate) rather than pulling every row to reduce in
        // JS — UNBILLED entries accumulate until billed, so an unbounded fetch
        // would grow with data volume.
        const [activeClients, sessionsThisWeek, monthAgg, unbilledAgg] = await Promise.all([
          prisma.client.count({ where: { coachId, status: "ACTIVE" } }),
          prisma.session.count({ where: { date: { gte: weekStart }, ...via } }),
          prisma.session.aggregate({
            where: { date: { gte: monthStart }, ...via },
            _sum: { billableMinutes: true },
          }),
          prisma.timeEntry.aggregate({
            where: { status: "UNBILLED", ...via },
            _sum: { amount: true },
          }),
        ]);
        const hoursThisMonth = (monthAgg._sum.billableMinutes ?? 0) / 60;
        const unbilled = Number(unbilledAgg._sum.amount ?? 0);
        return jsonResult({
          scope: "coach",
          coachId,
          activeClients,
          sessionsThisWeek,
          hoursThisMonth: Math.round(hoursThisMonth * 100) / 100,
          unbilled,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── list_feedback (read) ───────────────────────────────
  server.registerTool(
    "list_feedback",
    {
      description:
        "List feedback and feature requests. A COACH sees their own submissions; " +
        "OWNER/ADMIN see everything. Returns each item's type (bug/feature), title, " +
        "current stage, priority, vote count, and comment count — newest activity first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)."),
      },
    },
    async ({ limit = 50 }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        // Feedback is scoped by submitter (a coach id), NOT the client-scoping model.
        const isAdmin = coach.role !== "COACH";
        const items = await prisma.feedbackItem.findMany({
          where: isAdmin ? {} : { submittedById: coach.id },
          orderBy: { updatedAt: "desc" },
          take: limit,
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            stage: true,
            priority: true,
            voteCount: true,
            appVersion: true,
            shippedInVersion: true,
            createdAt: true,
            submittedBy: { select: { id: true, name: true } },
            _count: { select: { comments: true } },
          },
        });
        return jsonResult({ count: items.length, feedback: items });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── get_daily_brief (read) ─────────────────────────────
  server.registerTool(
    "get_daily_brief",
    {
      description:
        "Get today's start-of-day briefing for the signed-in coach: today's coaching " +
        "schedule, and for each session a short prep (what to remember, an opening " +
        "question, open action items) plus a summary of the day's tone and billable " +
        "hours. Built from the coach's Google Calendar and their clients' session " +
        "history. An OWNER/ADMIN may pass coachId to view another coach's day.",
      inputSchema: {
        coachId: z
          .string()
          .uuid()
          .optional()
          .describe("OWNER/ADMIN only: view this coach's brief instead of your own."),
      },
    },
    async ({ coachId }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        // One coach's day. A COACH is pinned to themselves; OWNER/ADMIN default
        // to their own brief and may target another via coachId.
        const briefCoachId = scopeCoachId(coach, coachId) ?? coach.id;
        const result = await buildDailyBrief(briefCoachId);
        if (result.status === "no_calendar") {
          return jsonResult({
            ok: false,
            error:
              "No Google Calendar is connected for this coach, so a daily brief can't be built.",
          });
        }
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── get_upcoming_meetings (read) ───────────────────────
  server.registerTool(
    "get_upcoming_meetings",
    {
      description:
        "List the signed-in coach's upcoming coaching meetings from their Google " +
        "Calendar over the next N days (default 7). Each meeting includes its title, " +
        "start/end time, duration, and the matched client (when a known client is on " +
        "the invite). Use this for 'what's on my schedule', 'who am I meeting this " +
        "week', or 'when is my next session with X'. An OWNER/ADMIN may pass coachId.",
      inputSchema: {
        daysAhead: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("How many days ahead to look (default 7, max 30)."),
        coachId: z
          .string()
          .uuid()
          .optional()
          .describe("OWNER/ADMIN only: view this coach's calendar instead of your own."),
      },
    },
    async ({ daysAhead = 7, coachId }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const scopedCoachId = scopeCoachId(coach, coachId) ?? coach.id;
        const result = await listUpcomingMeetings(scopedCoachId, daysAhead * 24);
        if (result.status === "no_calendar") {
          return jsonResult({
            ok: false,
            error: "No Google Calendar is connected for this coach.",
          });
        }
        return jsonResult({
          ok: true,
          daysAhead,
          count: result.count,
          meetings: result.meetings,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ═══ SAFE WRITES ════════════════════════════════════════
  // Read + safe writes only. Billing writes (generate/adjust/approve/send an
  // invoice) are deliberately NOT exposed here — those stay on the website.

  // ─── create_client (write) ──────────────────────────────
  server.registerTool(
    "create_client",
    {
      description:
        "Add a new coaching client to the signed-in coach's book. Requires a name " +
        "and a valid email. The client's rate defaults to the coach's standing rate. " +
        "Fails clearly if the coach already has a client with that email.",
      inputSchema: {
        name: z.string().min(1).describe("The client's full name."),
        email: z.string().email().describe("The client's email (unique within your book)."),
        company: z.string().optional(),
        phone: z.string().optional(),
        hourlyRate: z.number().positive().optional().describe("Override the default rate (dollars/hr)."),
        notes: z.string().optional(),
      },
    },
    async ({ name, email, company, phone, hourlyRate, notes }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        // Always the caller's OWN book — no cross-coach create over MCP.
        const { created, failed } = await createClients(coach.id, [
          { name, email, company, phone, hourlyRate, notes },
        ]);
        if (created.length > 0) {
          return jsonResult({ ok: true, created: created[0] });
        }
        return jsonResult({ ok: false, error: failed[0]?.error ?? "Could not create client." });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── submit_feedback (write) ────────────────────────────
  server.registerTool(
    "submit_feedback",
    {
      description:
        "Submit a bug report or feature request for CoachIQ itself. It's filed under " +
        "your name and enters the roadmap at the 'Submitted' stage, where the team can " +
        "see and respond to it. The app version is captured automatically.",
      inputSchema: {
        type: z.enum(["BUG", "FEATURE"]).describe("Whether this is a bug or a feature request."),
        title: z.string().min(1).describe("A short, clear title."),
        body: z.string().min(1).describe("The details — what happened, or what you'd like."),
      },
    },
    async ({ type, title, body }, extra) => {
      try {
        const coach = await resolveMcpCoach(extra);
        const created = await prisma.$transaction(async (tx) => {
          const item = await tx.feedbackItem.create({
            data: {
              type,
              title: title.slice(0, 200),
              body: body.slice(0, 5000),
              submittedById: coach.id,
              appVersion: APP_VERSION,
              // No browser context over MCP — these are optional by design.
              userAgent: "MCP",
              pageUrl: null,
            },
            select: { id: true },
          });
          // Filing is a real transition — the roadmap timeline reads these rows.
          await tx.feedbackStageChange.create({
            data: { feedbackId: item.id, fromStage: null, toStage: "SUBMITTED", changedById: coach.id },
          });
          return item;
        });
        return jsonResult({ ok: true, feedbackId: created.id, stage: "SUBMITTED" });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── create_prospect (write) ────────────────────────────
  server.registerTool(
    "create_prospect",
    {
      description:
        "Add a new sales-pipeline prospect (lead) to the signed-in coach's pipeline. " +
        "Lands in the first open stage unless a stageId is given (which must be an " +
        "open, non-terminal stage). Records the stage-entry in history automatically.",
      inputSchema: {
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        company: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        opportunityType: z
          .enum(["COACHING", "FACILITATION", "IMPLEMENTATION", "MULTIPLE"])
          .optional()
          .describe("Default COACHING."),
        needSummary: z.string().optional().describe("Description of the prospect's need."),
        notes: z.string().optional(),
        stageId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional open stage to start in; defaults to the first open stage."),
      },
    },
    async (args, extra) => {
      try {
        const { coach, userId } = await resolveMcpActor(extra);
        // Same shared service the HTTP route uses (single-row batch). Always the
        // caller's OWN book — no cross-coach create over MCP.
        const result = await createProspects(coach.id, [args], { coachId: coach.id, userId });
        if (!result.ok) {
          return jsonResult({ ok: false, error: result.message });
        }
        if (result.created.length > 0) {
          return jsonResult({ ok: true, prospect: result.created[0] });
        }
        return jsonResult({
          ok: false,
          error: result.failed[0]?.error ?? "Could not create prospect.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── log_prospect_activity (write) ──────────────────────
  server.registerTool(
    "log_prospect_activity",
    {
      description:
        "Record an activity on a prospect: a LOGGED activity already happened (a call " +
        "you made, a note); a PLANNED activity is scheduled for the future and becomes " +
        "the prospect's 'next activity'. Keeps the pipeline's stalest-first ordering " +
        "accurate. Only works on a prospect you own or are assigned.",
      inputSchema: {
        prospectId: z.string().uuid(),
        kind: z.enum(["LOGGED", "PLANNED"]).describe("LOGGED = already happened; PLANNED = scheduled."),
        activityAt: z
          .string()
          .datetime({ offset: true, local: true })
          .optional()
          .describe("ISO timestamp (UTC, offset, or local); when it happened or is scheduled. Defaults to now."),
        notes: z.string().optional(),
      },
    },
    async ({ prospectId, kind, activityAt, notes }, extra) => {
      try {
        const { coach } = await resolveMcpActor(extra);
        const coachId = scopeCoachId(coach, undefined);
        const result = await createPipelineActivity({
          prospectId,
          kind,
          activityAt: activityAt ? new Date(activityAt) : new Date(),
          notes: notes ?? null,
          ownerId: coach.id,
          scopeCoachId: coachId,
        });
        if (!result.ok) {
          return jsonResult({ ok: false, error: "No such prospect in your scope." });
        }
        return jsonResult({ ok: true, activity: result.activity });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ─── move_prospect_stage (write) ────────────────────────
  server.registerTool(
    "move_prospect_stage",
    {
      description:
        "Move a prospect to a different pipeline stage. Records stage history, resets " +
        "the days-in-stage clock, and keeps next-activity tracking correct. Moving to a " +
        "LOST stage requires a lostReason. Does NOT create a client on a WON move — the " +
        "response tells you when conversion is available (do that on the website). Only " +
        "works on a prospect you own or are assigned.",
      inputSchema: {
        prospectId: z.string().uuid(),
        stageId: z.string().uuid().describe("The target stage id."),
        lostReason: z.string().optional().describe("Required when moving to a LOST stage."),
      },
    },
    async ({ prospectId, stageId, lostReason }, extra) => {
      try {
        const { coach, userId } = await resolveMcpActor(extra);
        const coachId = scopeCoachId(coach, undefined);
        // Same shared service the stage route uses — one audit shape, one owner
        // of the four side-effects (history, clear/refresh, audit).
        const result = await moveProspectStage({
          prospectId,
          toStageId: stageId,
          lostReason,
          scopeCoachId: coachId,
          changedByCoachId: coach.id,
          auditActor: userId,
        });
        if (!result.ok) {
          const friendly =
            result.code === "prospect_not_found"
              ? "No such prospect in your scope."
              : result.message;
          return jsonResult({ ok: false, error: friendly });
        }
        if (result.status === "unchanged") {
          return jsonResult({ ok: true, status: "unchanged" });
        }
        return jsonResult({
          ok: true,
          status: "moved",
          stage: { id: result.stage.id, name: result.stage.name, terminal: result.stage.terminal },
          convertAvailable: result.convertAvailable,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
