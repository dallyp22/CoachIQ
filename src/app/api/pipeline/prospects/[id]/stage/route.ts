import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, canAccessProspect, authzResponse } from "@/lib/authz";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { clearNextActivityAt, refreshNextActivityAt } from "@/lib/pipeline/next-activity";
import { cleanString, readJsonBody } from "@/lib/pipeline/stages";

/**
 * POST /api/pipeline/prospects/[id]/stage — move a prospect (PRD §6.5).
 *
 * The one place stageId changes. It writes ProspectStageChange, resets
 * stageEnteredAt, enforces the LOST-needs-a-reason rule, and clears
 * nextActivityAt on close. A generic PATCH is refused precisely so all four
 * cannot be skipped.
 *
 * Moving to a WON stage does NOT create the client here. Convert is a
 * separate call (POST /[id]/convert) because it needs an email the prospect
 * may not have, and firing it implicitly would mean a stage move could
 * silently mint a billable record — or silently fail to.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  let coachId: string | null;
  try {
    actor = await requireCoach();
    coachId = scopeCoachId(actor, null);
  } catch (err) {
    return authzResponse(err);
  }
  const { userId } = await auth();

  const { id } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const toStageId = cleanString(body?.stageId);
  if (!toStageId) {
    return NextResponse.json({ error: "stageId is required" }, { status: 400 });
  }

  const [prospect, toStage] = await Promise.all([
    prisma.prospect.findUnique({
      where: { id },
      select: {
        id: true,
        coachId: true,
        assignedCoachId: true,
        stageId: true,
        convertedToClientId: true,
        stage: { select: { id: true, name: true, terminal: true } },
      },
    }),
    prisma.pipelineStage.findUnique({
      where: { id: toStageId },
      select: { id: true, name: true, terminal: true, isArchived: true },
    }),
  ]);

  if (!prospect || !canAccessProspect(coachId, prospect)) {
    return NextResponse.json({ error: "Prospect not found" }, { status: 404 });
  }
  if (!toStage) {
    return NextResponse.json({ error: "Stage not found" }, { status: 404 });
  }
  if (toStage.isArchived) {
    return NextResponse.json(
      { error: `"${toStage.name}" is archived — prospects cannot be moved into it` },
      { status: 400 },
    );
  }

  if (prospect.stageId === toStage.id) {
    // Idempotent: a double-click must not write a self-transition into the
    // history the funnel reports read.
    return NextResponse.json({ status: "unchanged", stage: toStage });
  }

  // LOST requires a reason (§6.5). Without it the closed-lost taxonomy that
  // §10.4 wants to derive later has nothing to derive from.
  const lostReason = cleanString(body?.lostReason);
  if (toStage.terminal === "LOST" && !lostReason) {
    return NextResponse.json(
      { error: "Moving a prospect to a lost stage requires a reason" },
      { status: 400 },
    );
  }

  const fromStageId = prospect.stageId;

  await prisma.$transaction(async (tx) => {
    await tx.prospect.update({
      where: { id },
      data: {
        stageId: toStage.id,
        stageEnteredAt: new Date(),
        // Clear a stale reason when reopening a lost prospect, so a row cannot
        // sit in an open stage still carrying "went with a competitor".
        lostReason: toStage.terminal === "LOST" ? lostReason : null,
      },
    });

    // Typed history — this is DATA the reports query (time in stage,
    // stage-to-stage conversion), not just a log line.
    await tx.prospectStageChange.create({
      data: { prospectId: id, fromStageId, toStageId: toStage.id, changedById: actor.id },
    });

    // A closed prospect must stop nagging. Left set, a dangling future planned
    // activity keeps it eligible for the overdue-amber state of §6.2.
    //
    // The else is load-bearing: REOPENING a closed prospect has to recompute,
    // or the column stays null while real planned activities sit underneath it.
    // The row would then claim "none scheduled" at the top of the stalest-first
    // list while its own dossier shows a booked call — silently, with no error,
    // until someone happened to touch an activity on it.
    if (toStage.terminal) {
      await clearNextActivityAt(tx, id);
    } else {
      await refreshNextActivityAt(tx, id);
    }

    await logEvent(tx, {
      event: BillingEvent.PROSPECT_STAGE_CHANGED,
      actor: userId,
      payload: {
        prospectId: id,
        from: prospect.stage.name,
        to: toStage.name,
        terminal: toStage.terminal,
        ...(lostReason ? { lostReason } : {}),
      },
    });
  });

  // Tell the UI whether to offer Convert, rather than making it re-derive the
  // rule. Already-converted prospects get no second offer.
  return NextResponse.json({
    status: "moved",
    stage: toStage,
    convertAvailable: toStage.terminal === "WON" && !prospect.convertedToClientId,
  });
}
