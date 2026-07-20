import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, canAccessProspect, authzResponse } from "@/lib/authz";
import { refreshNextActivityAt } from "@/lib/pipeline/next-activity";
import { cleanString, readJsonBody } from "@/lib/pipeline/stages";

/**
 * POST  /api/pipeline/activities — log something that happened, or plan something
 * PATCH /api/pipeline/activities — edit, reschedule, or complete one
 *
 * EVERY mutation here calls refreshNextActivityAt inside the same transaction.
 * Prospect.nextActivityAt drives the default sort, and drift is SILENT — no
 * error, just a list ordered wrongly, which nobody can falsify from the UI.
 * The PATCH path is the one that hides: rescheduling Thursday's call to next
 * Tuesday is neither a create nor a complete.
 */

const KINDS = ["LOGGED", "PLANNED"];

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Load the parent prospect and authorize against it — activities inherit its scope. */
async function authorizeProspect(prospectId: string, coachId: string | null) {
  const prospect = await prisma.prospect.findUnique({
    where: { id: prospectId },
    select: { id: true, coachId: true, assignedCoachId: true },
  });
  if (!prospect || !canAccessProspect(coachId, prospect)) return null;
  return prospect;
}

export async function POST(request: NextRequest) {
  let actor;
  let coachId: string | null;
  try {
    actor = await requireCoach();
    coachId = scopeCoachId(actor, null);
  } catch (err) {
    return authzResponse(err);
  }

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const prospectId = cleanString(body?.prospectId);
  if (!prospectId) {
    return NextResponse.json({ error: "prospectId is required" }, { status: 400 });
  }

  const prospect = await authorizeProspect(prospectId, coachId);
  if (!prospect) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  const kind = typeof body?.kind === "string" && KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) {
    return NextResponse.json({ error: "kind must be LOGGED or PLANNED" }, { status: 400 });
  }

  const activityAt = parseDate(body?.activityAt) ?? new Date();

  // Owner defaults to the person doing it. An explicit owner lets Todd plan a
  // call for Kurt, which is the whole reason the field is a dropdown.
  let ownerId: string | null = actor.id;
  if ("ownerId" in body) {
    const requested = cleanString(body.ownerId);
    if (requested) {
      const exists = await prisma.coach.findUnique({ where: { id: requested }, select: { id: true } });
      if (!exists) return NextResponse.json({ error: "Coach not found" }, { status: 404 });
      ownerId = requested;
    } else {
      ownerId = null; // explicit null = "System"
    }
  }

  const activity = await prisma.$transaction(async (tx) => {
    const created = await tx.pipelineActivity.create({
      data: {
        prospectId,
        kind: kind as never,
        activityAt,
        notes: cleanString(body?.notes),
        ownerId,
        // A LOGGED activity already happened, so it is complete on arrival.
        // Without this it would look like an open plan forever and keep
        // reappearing as the prospect's "next activity".
        completedAt: kind === "LOGGED" ? activityAt : null,
      },
      select: { id: true, kind: true, activityAt: true, notes: true, completedAt: true },
    });

    await refreshNextActivityAt(tx, prospectId);
    return created;
  });

  return NextResponse.json({ activity }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  let coachId: string | null;
  try {
    const actor = await requireCoach();
    coachId = scopeCoachId(actor, null);
  } catch (err) {
    return authzResponse(err);
  }

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const activityId = cleanString(body?.id);
  if (!activityId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const activity = await prisma.pipelineActivity.findUnique({
    where: { id: activityId },
    select: { id: true, prospectId: true, kind: true, activityAt: true, completedAt: true },
  });
  if (!activity) return NextResponse.json({ error: "Activity not found" }, { status: 404 });

  const prospect = await authorizeProspect(activity.prospectId, coachId);
  if (!prospect) return NextResponse.json({ error: "Activity not found" }, { status: 404 });

  const data: Record<string, unknown> = {};

  // Reschedule. THIS is the write path that would otherwise be missed: it
  // changes which activity is soonest without creating or deleting anything.
  if ("activityAt" in body) {
    const when = parseDate(body.activityAt);
    if (!when) return NextResponse.json({ error: "activityAt is not a valid date" }, { status: 400 });
    data.activityAt = when;
  }

  if ("notes" in body) data.notes = cleanString(body.notes);

  // Complete / re-open. Completing is what turns a plan into the prospect's
  // "last activity" and removes it from the running for "next".
  if ("completed" in body) {
    if (body.completed) {
      data.completedAt = parseDate(body.completedAt) ?? new Date();
    } else {
      data.completedAt = null;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.pipelineActivity.update({
      where: { id: activityId },
      data,
      select: { id: true, kind: true, activityAt: true, notes: true, completedAt: true },
    });
    const nextActivityAt = await refreshNextActivityAt(tx, activity.prospectId);
    return { row, nextActivityAt };
  });

  return NextResponse.json({ activity: updated.row, nextActivityAt: updated.nextActivityAt });
}

export async function DELETE(request: NextRequest) {
  let coachId: string | null;
  try {
    const actor = await requireCoach();
    coachId = scopeCoachId(actor, null);
  } catch (err) {
    return authzResponse(err);
  }

  const activityId = cleanString(request.nextUrl.searchParams.get("id"));
  if (!activityId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const activity = await prisma.pipelineActivity.findUnique({
    where: { id: activityId },
    select: { id: true, prospectId: true },
  });
  if (!activity) return NextResponse.json({ error: "Activity not found" }, { status: 404 });

  const prospect = await authorizeProspect(activity.prospectId, coachId);
  if (!prospect) return NextResponse.json({ error: "Activity not found" }, { status: 404 });

  await prisma.$transaction(async (tx) => {
    await tx.pipelineActivity.delete({ where: { id: activityId } });
    // The next-next planned activity moves up.
    await refreshNextActivityAt(tx, activity.prospectId);
  });

  return NextResponse.json({ status: "deleted" });
}
