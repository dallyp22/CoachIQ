import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, prospectWhere, authzResponse } from "@/lib/authz";
import { buildPipelineSummary, type ProspectRow } from "@/lib/pipeline/report-math";
import { liveStages } from "@/lib/pipeline/stages";

/**
 * GET /api/pipeline/reports/summary — PRD §7.1 and §7.2.
 *
 * The arithmetic lives in report-math.ts as pure functions, so the empty
 * pipeline and the empty stage are unit-tested without a database. This route
 * only gathers rows. Note every average can be null and MUST stay null —
 * "0 days" claims nothing is sitting; the truth is nothing is there.
 */
export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  const stages = await liveStages();
  const openStages = stages.filter((s) => s.terminal === null);

  const openProspects = await prisma.prospect.findMany({
    where: { ...prospectWhere(coachId), stage: { terminal: null } },
    select: {
      id: true,
      stageId: true,
      createdAt: true,
      stageEnteredAt: true,
      firstName: true,
      lastName: true,
      company: true,
      opportunityType: true,
      nextActivityAt: true,
      stage: { select: { id: true, name: true, isHot: true } },
      assignedCoach: { select: { id: true, name: true } },
    },
  });

  // Last-activity date for every open prospect, in one query. Feeds the
  // "average time since last activity" statistic — and the null case matters:
  // a prospect with zero activities falls back to createdAt, which is how
  // untouched leads stay IN the staleness metric instead of being excluded
  // from it (excluding them would make the number improve as neglect grew).
  const lastActivity = await prisma.pipelineActivity.groupBy({
    by: ["prospectId"],
    where: {
      prospectId: { in: openProspects.map((p) => p.id) },
      OR: [{ kind: "LOGGED" }, { completedAt: { not: null } }],
    },
    _max: { activityAt: true },
  });
  const lastByProspect = new Map(
    lastActivity.map((l) => [l.prospectId, l._max.activityAt ?? null]),
  );

  const rows: ProspectRow[] = openProspects.map((p) => ({
    id: p.id,
    stageId: p.stageId,
    createdAt: p.createdAt,
    stageEnteredAt: p.stageEnteredAt,
    lastActivityAt: lastByProspect.get(p.id) ?? null,
  }));

  const now = new Date();
  const summary = buildPipelineSummary(rows, openStages, now);

  // §7.1 Hot Prospects — open prospects whose stage is flagged hot. Which
  // stages count is an ADMIN toggle, not a constant, so this cannot go stale
  // when the team finally settles on stage names.
  const hot = openProspects
    .filter((p) => p.stage.isHot)
    .map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      company: p.company,
      opportunityType: p.opportunityType,
      stage: p.stage,
      assignedCoach: p.assignedCoach,
      nextActivityAt: p.nextActivityAt,
      lastActivityAt: lastByProspect.get(p.id) ?? null,
      createdAt: p.createdAt,
    }));

  return NextResponse.json({ summary, hot, generatedAt: now });
}
