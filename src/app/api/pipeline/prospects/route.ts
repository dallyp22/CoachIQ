import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, prospectWhere, authzResponse } from "@/lib/authz";
import { STALEST_FIRST } from "@/lib/pipeline/next-activity";
import { readJsonBody } from "@/lib/pipeline/stages";
import {
  createProspects,
  terminalFilterForStatus,
  daysSince,
  OPPORTUNITY_TYPES,
  type ProspectInput,
} from "@/lib/pipeline/writes";
import type { Prisma } from "@/generated/prisma/client";

/**
 * GET  /api/pipeline/prospects — the list view (PRD §6.2)
 * POST /api/pipeline/prospects — add one, or paste a batch (§6.4, §13.5)
 *
 * The create logic (open-stage guard, assignee validation, per-row transaction,
 * audit) lives in createProspects() in src/lib/pipeline/writes.ts so the MCP
 * create_prospect tool runs the identical logic.
 */

const PAGE_SIZE = 50;

export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  const params = request.nextUrl.searchParams;
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const stageId = params.get("stageId");
  const opportunityType = params.get("opportunityType");
  // open | won | lost | all — defaults to open, since a pipeline is about
  // what is still live. Closed prospects are a deliberate lookup.
  const status = params.get("status") ?? "open";

  const where: Prisma.ProspectWhereInput = {
    ...prospectWhere(coachId),
    ...(stageId ? { stageId } : {}),
    ...(opportunityType && OPPORTUNITY_TYPES.includes(opportunityType)
      ? { opportunityType: opportunityType as never }
      : {}),
    ...terminalFilterForStatus(status),
  };

  const [total, rows] = await Promise.all([
    prisma.prospect.count({ where }),
    prisma.prospect.findMany({
      where,
      // Stalest first. See STALEST_FIRST — the NULLS FIRST is load-bearing,
      // not cosmetic: "none scheduled" must outrank every scheduled date.
      orderBy: [STALEST_FIRST, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        company: true,
        opportunityType: true,
        email: true,
        stageEnteredAt: true,
        nextActivityAt: true,
        createdAt: true,
        convertedToClientId: true,
        stage: { select: { id: true, name: true, terminal: true, isHot: true } },
        coach: { select: { id: true, name: true } },
        assignedCoach: { select: { id: true, name: true } },
      },
    }),
  ]);

  // "Last activity" is the one derived field still worth a second query —
  // unlike nextActivityAt it is not sorted on, so it does not need a column.
  // ONE query for the whole page, never one per row.
  const lastByProspect = await lastActivityFor(rows.map((r) => r.id));

  return NextResponse.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    prospects: rows.map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      company: p.company,
      opportunityType: p.opportunityType,
      email: p.email,
      stage: p.stage,
      daysInStage: daysSince(p.stageEnteredAt),
      nextActivityAt: p.nextActivityAt,
      lastActivity: lastByProspect.get(p.id) ?? null,
      coach: p.coach,
      assignedCoach: p.assignedCoach,
      convertedToClientId: p.convertedToClientId,
      createdAt: p.createdAt,
    })),
  });
}

/**
 * Most recent completed/logged activity per prospect, in one round trip.
 *
 * groupBy gives the max date per prospect; a second query fetches those rows'
 * notes and owner. Two queries for the page regardless of its size — the
 * alternative is one per row, on the module's primary screen.
 */
async function lastActivityFor(prospectIds: string[]) {
  const out = new Map<string, { activityAt: Date; notes: string | null; owner: { id: string; name: string } | null }>();
  if (prospectIds.length === 0) return out;

  const latest = await prisma.pipelineActivity.groupBy({
    by: ["prospectId"],
    where: {
      prospectId: { in: prospectIds },
      OR: [{ kind: "LOGGED" }, { completedAt: { not: null } }],
    },
    _max: { activityAt: true },
  });
  if (latest.length === 0) return out;

  const rows = await prisma.pipelineActivity.findMany({
    where: {
      OR: latest
        .filter((l) => l._max.activityAt !== null)
        .map((l) => ({ prospectId: l.prospectId, activityAt: l._max.activityAt! })),
    },
    select: {
      prospectId: true,
      activityAt: true,
      notes: true,
      owner: { select: { id: true, name: true } },
    },
  });

  for (const r of rows) {
    // Two activities can share the exact timestamp; keep the first and move on
    // rather than rendering a row twice.
    if (!out.has(r.prospectId)) {
      out.set(r.prospectId, { activityAt: r.activityAt, notes: r.notes, owner: r.owner });
    }
  }
  return out;
}

export async function POST(request: NextRequest) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }
  const { userId } = await auth();

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const rows: ProspectInput[] = Array.isArray(body?.prospects)
    ? body.prospects
    : Array.isArray(body)
      ? body
      : [body];

  if (rows.length === 0) {
    return NextResponse.json({ error: "No prospects supplied" }, { status: 400 });
  }

  // Whose book? Same rule as clients: a COACH may only add to their own —
  // reading coachId from the body would reopen the hole scoping just closed.
  let coachId = actor.id;
  if (actor.role !== "COACH" && typeof body?.coachId === "string" && body.coachId) {
    const target = await prisma.coach.findUnique({
      where: { id: body.coachId },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: "Coach not found" }, { status: 404 });
    coachId = target.id;
  }

  const result = await createProspects(coachId, rows, { coachId: actor.id, userId });
  if (!result.ok) {
    // No open stage to place a prospect in.
    return NextResponse.json({ error: result.message }, { status: 409 });
  }

  const { created, failed } = result;
  // Partial success reports both halves — re-pasting a 40-row tracker to fix
  // one line is miserable.
  const status = created.length === 0 ? 400 : failed.length > 0 ? 207 : 201;
  return NextResponse.json({ created, failed }, { status });
}
