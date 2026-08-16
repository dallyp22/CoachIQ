import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { readJsonBody, cleanString } from "@/lib/pipeline/stages";
import { isValidStage, isValidPriority } from "@/lib/feedback";
import { APP_VERSION } from "@/lib/version";
import type { Prisma } from "@/generated/prisma/client";

/**
 * PATCH /api/feedback/[id] — triage. ADMIN+ only.
 *
 * The single place an item's stage, priority, decline reason, and GitHub mirror
 * change. A stage move writes a FeedbackStageChange (the timeline source) and
 * stamps ackAt / shippedAt / shippedInVersion, so those become column reads
 * rather than scans of the change log. DECLINED requires a reason — the honest
 * "no" is the whole point of the module.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    // ADMIN is the least privileged role allowed to triage; a COACH may only
    // file and watch their own reports.
    actor = await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const item = await prisma.feedbackItem.findUnique({
    where: { id },
    select: { id: true, stage: true, ackAt: true, declineReason: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Feedback item not found" }, { status: 404 });
  }

  const data: Prisma.FeedbackItemUpdateInput = {};
  const note = cleanString(body.note);

  // ── Stage move ──────────────────────────────────────
  let stageMove: { from: typeof item.stage; to: typeof item.stage } | null = null;
  if (body.stage !== undefined) {
    if (!isValidStage(body.stage)) {
      return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    }
    if (body.stage !== item.stage) {
      const to = body.stage;

      if (to === "DECLINED") {
        const reason = cleanString(body.declineReason) ?? item.declineReason;
        if (!reason) {
          return NextResponse.json(
            { error: "Declining a request needs a reason — the reporter sees it." },
            { status: 400 }
          );
        }
        data.declineReason = reason;
      }

      // First time it leaves SUBMITTED, record the acknowledgement moment.
      if (item.ackAt === null && to !== "SUBMITTED") {
        data.ackAt = new Date();
      }

      if (to === "SHIPPED") {
        data.shippedAt = new Date();
        data.shippedInVersion = cleanString(body.shippedInVersion) ?? APP_VERSION;
      }

      data.stage = to;
      stageMove = { from: item.stage, to };
    }
  }

  // ── Priority (present-but-null clears it) ───────────
  if ("priority" in body) {
    if (body.priority === null) {
      data.priority = null;
    } else if (isValidPriority(body.priority)) {
      data.priority = body.priority;
    } else {
      return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
    }
  }

  // ── GitHub mirror link (present-but-null clears it) ─
  if ("githubUrl" in body) {
    const url = cleanString(body.githubUrl);
    if (url && !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "GitHub URL must start with http(s)://" }, { status: 400 });
    }
    data.githubUrl = url;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.feedbackItem.update({ where: { id }, data });
    if (stageMove) {
      await tx.feedbackStageChange.create({
        data: {
          feedbackId: id,
          fromStage: stageMove.from,
          toStage: stageMove.to,
          note,
          changedById: actor.id,
        },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
