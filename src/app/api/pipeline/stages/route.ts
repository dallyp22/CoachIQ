import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { liveStages, canArchiveStage, cleanString } from "@/lib/pipeline/stages";

/**
 * GET   /api/pipeline/stages — the board's columns (any coach; they populate dropdowns)
 * PATCH /api/pipeline/stages — rename / reorder / isHot / archive (ADMIN+)
 *
 * Deliberately NO create, and no way to set `terminal`. Stage names are the
 * team's to decide (PRD §10.1), which is why rename ships — but adding a stage
 * or re-marking one terminal are the operations that can strand the
 * convert-to-client rule, and the partial unique index would reject half of
 * them at the database anyway. v1 edits the seven seeded stages.
 */

export async function GET() {
  try {
    await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  const stages = await liveStages();
  return NextResponse.json({ stages });
}

type StagePatch = {
  id?: unknown;
  name?: unknown;
  sortOrder?: unknown;
  isHot?: unknown;
  isArchived?: unknown;
};

export async function PATCH(request: NextRequest) {
  try {
    // Stage definitions are practice-wide: one coach renaming a column
    // reshapes everyone's board and every report built on it.
    await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }
  const { userId } = await auth();

  const body = await request.json();
  const patches: StagePatch[] = Array.isArray(body?.stages) ? body.stages : [body];

  if (patches.length === 0) {
    return NextResponse.json({ error: "No stages supplied" }, { status: 400 });
  }

  // Validate everything BEFORE writing anything. A reorder is a batch of
  // sortOrder updates, and applying half of one leaves the board scrambled.
  const resolved: Array<{ id: string; data: Record<string, unknown> }> = [];

  for (const patch of patches) {
    const id = cleanString(patch.id);
    if (!id) return NextResponse.json({ error: "Each stage needs an id" }, { status: 400 });

    const stage = await prisma.pipelineStage.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!stage) return NextResponse.json({ error: `Stage ${id} not found` }, { status: 404 });

    const data: Record<string, unknown> = {};

    if ("name" in patch) {
      const name = cleanString(patch.name);
      if (!name) return NextResponse.json({ error: "A stage name cannot be empty" }, { status: 400 });
      data.name = name;
    }
    if ("sortOrder" in patch) {
      const order = Number(patch.sortOrder);
      if (!Number.isFinite(order)) {
        return NextResponse.json({ error: "sortOrder must be a number" }, { status: 400 });
      }
      data.sortOrder = Math.trunc(order);
    }
    if ("isHot" in patch) data.isHot = Boolean(patch.isHot);

    if ("isArchived" in patch) {
      const archiving = Boolean(patch.isArchived);
      if (archiving) {
        // The guard SQL cannot express: "last" is a count, not a constraint.
        const verdict = await canArchiveStage(id);
        if (!verdict.ok) {
          return NextResponse.json({ error: verdict.reason }, { status: 409 });
        }
      }
      data.isArchived = archiving;
    }

    if (Object.keys(data).length > 0) resolved.push({ id, data });
  }

  if (resolved.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    for (const { id, data } of resolved) {
      await tx.pipelineStage.update({ where: { id }, data });
    }
    await logEvent(tx, {
      event: BillingEvent.PIPELINE_STAGE_UPDATED,
      actor: userId,
      payload: { stages: resolved.map((r) => ({ id: r.id, fields: Object.keys(r.data) })) },
    });
  });

  return NextResponse.json({ stages: await liveStages() });
}
