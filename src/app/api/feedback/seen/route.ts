import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";

/**
 * POST /api/feedback/seen — mark the feedback the current coach can see as read.
 *
 * Stamps feedbackLastSeenAt to now, which is what the unread nav badge measures
 * against. Called when the coach opens /feedback.
 */
export async function POST() {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  await prisma.coach.update({
    where: { id: actor.id },
    data: { feedbackLastSeenAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
