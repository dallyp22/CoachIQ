import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import {
  requireCoach,
  scopeCoachId,
  canAccessProspect,
  authzResponse,
} from "@/lib/authz";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { cleanString, readJsonBody } from "@/lib/pipeline/stages";

/**
 * GET / PATCH / DELETE a single prospect — the dossier (PRD §6.3).
 *
 * Every handler resolves the row, then checks canAccessProspect and answers
 * 404 (not 403) on refusal: confirming a prospect exists but belongs to
 * someone else is itself a disclosure.
 */

const OPPORTUNITY_TYPES = ["COACHING", "FACILITATION", "IMPLEMENTATION", "MULTIPLE"];

/** Shared load + authorize. Returns the row or the response to send instead. */
async function loadProspect(id: string, coachId: string | null) {
  const prospect = await prisma.prospect.findUnique({
    where: { id },
    select: {
      id: true,
      coachId: true,
      assignedCoachId: true,
      firstName: true,
      lastName: true,
      company: true,
      opportunityType: true,
      needSummary: true,
      email: true,
      phone: true,
      notes: true,
      source: true,
      stageId: true,
      stageEnteredAt: true,
      nextActivityAt: true,
      lostReason: true,
      convertedToClientId: true,
      createdAt: true,
      updatedAt: true,
      stage: { select: { id: true, name: true, terminal: true, isHot: true } },
      coach: { select: { id: true, name: true } },
      assignedCoach: { select: { id: true, name: true } },
    },
  });

  if (!prospect || !canAccessProspect(coachId, prospect)) return null;
  return prospect;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await ctx.params;
  const prospect = await loadProspect(id, coachId);
  if (!prospect) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  // The dossier's right pane: the full log, reverse-chron, activities and
  // stage moves interleaved by the UI.
  const [activities, stageChanges] = await Promise.all([
    prisma.pipelineActivity.findMany({
      where: { prospectId: id },
      orderBy: { activityAt: "desc" },
      select: {
        id: true,
        kind: true,
        activityAt: true,
        notes: true,
        completedAt: true,
        createdAt: true,
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.prospectStageChange.findMany({
      where: { prospectId: id },
      orderBy: { changedAt: "desc" },
      select: { id: true, fromStageId: true, toStageId: true, changedAt: true, changedById: true },
    }),
  ]);

  return NextResponse.json({ prospect, activities, stageChanges });
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
  const existing = await loadProspect(id, coachId);
  if (!existing) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  // Stage is deliberately NOT editable here — it moves through
  // POST /[id]/stage, which writes history, resets stageEnteredAt, and
  // enforces the lostReason/convert rules. Letting a generic PATCH set it
  // would route around all three.
  if ("stageId" in body) {
    return NextResponse.json(
      { error: "Use POST /api/pipeline/prospects/[id]/stage to move a prospect between stages" },
      { status: 400 },
    );
  }

  const data: Record<string, unknown> = {};
  if ("firstName" in body) data.firstName = cleanString(body.firstName) ?? existing.firstName;
  if ("lastName" in body) data.lastName = cleanString(body.lastName) ?? existing.lastName;
  if ("company" in body) data.company = cleanString(body.company);
  if ("needSummary" in body) data.needSummary = cleanString(body.needSummary);
  if ("email" in body) data.email = cleanString(body.email)?.toLowerCase() ?? null;
  if ("phone" in body) data.phone = cleanString(body.phone);
  if ("notes" in body) data.notes = cleanString(body.notes);
  if ("opportunityType" in body) {
    if (typeof body.opportunityType !== "string" || !OPPORTUNITY_TYPES.includes(body.opportunityType)) {
      return NextResponse.json({ error: "Unknown opportunity type" }, { status: 400 });
    }
    data.opportunityType = body.opportunityType;
  }
  if ("assignedCoachId" in body) {
    const target = cleanString(body.assignedCoachId);
    if (target) {
      const exists = await prisma.coach.findUnique({ where: { id: target }, select: { id: true } });
      if (!exists) return NextResponse.json({ error: "Coach not found" }, { status: 404 });
    }
    // A COACH reassigning away from themselves can lose sight of the row —
    // that is intended (handing a lead off), and OWNER/ADMIN can always see it.
    data.assignedCoachId = target;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.prospect.update({ where: { id }, data });
    await logEvent(tx, {
      event: BillingEvent.PROSPECT_UPDATED,
      actor: userId,
      payload: { prospectId: id, fields: Object.keys(data) },
    });
  });

  return NextResponse.json({ status: "updated" });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
  const existing = await loadProspect(id, coachId);
  if (!existing) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  // A converted prospect is the audit trail linking a lead to a paying client.
  // Deleting it would sever that link while leaving the client in place, and
  // §3 tracks conversion as a headline metric. Close it as lost instead.
  if (existing.convertedToClientId) {
    return NextResponse.json(
      { error: "This prospect was converted to a client — it cannot be deleted without breaking that link" },
      { status: 409 },
    );
  }

  // Hard delete: a prospect is not a billing record and carries no money.
  // Activities and stage changes cascade (FK ON DELETE CASCADE).
  await prisma.$transaction(async (tx) => {
    await tx.prospect.delete({ where: { id } });
    await logEvent(tx, {
      event: BillingEvent.PROSPECT_DELETED,
      actor: userId,
      payload: {
        prospectId: id,
        name: `${existing.firstName} ${existing.lastName}`.trim(),
        coachId: existing.coachId,
      },
    });
  });

  return NextResponse.json({ status: "deleted" });
}
