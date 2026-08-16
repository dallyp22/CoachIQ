import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";

/**
 * POST/DELETE /api/feedback/[id]/vote — an upvote is "me too / I want this".
 *
 * One vote per coach per item (composite PK bars a double vote). Both verbs are
 * idempotent, and voteCount is RECOMPUTED from the vote rows inside the
 * transaction rather than incremented — a dropped or doubled request can never
 * drift the tally.
 *
 * A coach may vote on anything visible on the roadmap: any non-declined item,
 * or one they filed themselves. A declined item that isn't theirs answers 404,
 * matching board visibility.
 */
async function assertVotable(id: string, actorId: string, isAdmin: boolean) {
  const item = await prisma.feedbackItem.findUnique({
    where: { id },
    select: { id: true, stage: true, submittedById: true },
  });
  if (!item) return null;
  if (item.stage === "DECLINED" && !isAdmin && item.submittedById !== actorId) return null;
  return item;
}

async function recount(id: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const count = await tx.feedbackVote.count({ where: { feedbackId: id } });
    await tx.feedbackItem.update({ where: { id }, data: { voteCount: count } });
    return count;
  });
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }
  const { id } = await ctx.params;
  const item = await assertVotable(id, actor.id, actor.role !== "COACH");
  if (!item) return NextResponse.json({ error: "Feedback item not found" }, { status: 404 });

  // Idempotent: a repeat vote is a no-op, not a duplicate row.
  await prisma.feedbackVote.createMany({
    data: [{ feedbackId: id, coachId: actor.id }],
    skipDuplicates: true,
  });
  const voteCount = await recount(id);
  return NextResponse.json({ voted: true, voteCount });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }
  const { id } = await ctx.params;
  const item = await assertVotable(id, actor.id, actor.role !== "COACH");
  if (!item) return NextResponse.json({ error: "Feedback item not found" }, { status: 404 });

  // Idempotent: deleteMany removes zero or one row without erroring.
  await prisma.feedbackVote.deleteMany({ where: { feedbackId: id, coachId: actor.id } });
  const voteCount = await recount(id);
  return NextResponse.json({ voted: false, voteCount });
}
