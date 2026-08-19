import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireCoach, scopeCoachId, authzResponse } from "@/lib/authz";
import { cleanString, readJsonBody } from "@/lib/pipeline/stages";
import { moveProspectStage } from "@/lib/pipeline/writes";

/**
 * POST /api/pipeline/prospects/[id]/stage — move a prospect (PRD §6.5).
 *
 * The move itself (ProspectStageChange, stageEnteredAt reset, LOST-needs-reason,
 * clear/refresh nextActivityAt, audit) lives in moveProspectStage() in
 * src/lib/pipeline/writes.ts so the MCP move_prospect_stage tool runs the exact
 * same logic and writes the exact same audit shape. This route only does the
 * HTTP shape + coach scoping.
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

  const result = await moveProspectStage({
    prospectId: id,
    toStageId,
    lostReason: cleanString(body?.lostReason),
    scopeCoachId: coachId,
    changedByCoachId: actor.id,
    auditActor: userId,
  });

  if (!result.ok) {
    const status =
      result.code === "prospect_not_found" || result.code === "stage_not_found" ? 404 : 400;
    return NextResponse.json({ error: result.message }, { status });
  }
  if (result.status === "unchanged") {
    return NextResponse.json({ status: "unchanged", stage: result.stage });
  }
  return NextResponse.json({
    status: "moved",
    stage: result.stage,
    convertAvailable: result.convertAvailable,
  });
}
