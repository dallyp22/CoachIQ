import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { readJsonBody, cleanString } from "@/lib/pipeline/stages";

/**
 * POST /api/feedback/[id]/comment — the dialogue channel.
 *
 * Who may comment:
 *   - ADMIN+ on any item (this is how the owner replies).
 *   - a COACH only on an item they submitted.
 *
 * asTeam posts with a null author, rendering as "CoachIQ Team" — the owner
 * speaking as the product. Only ADMIN+ may do that; a coach always signs their
 * own name, so the flag is ignored for them rather than rejected.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const text = cleanString(body.body);
  if (!text) {
    return NextResponse.json({ error: "A comment can't be empty" }, { status: 400 });
  }

  const item = await prisma.feedbackItem.findUnique({
    where: { id },
    select: { id: true, submittedById: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Feedback item not found" }, { status: 404 });
  }

  const isAdmin = actor.role !== "COACH";
  if (!isAdmin && item.submittedById !== actor.id) {
    return NextResponse.json(
      { error: "You can only comment on feedback you submitted." },
      { status: 403 }
    );
  }

  const asTeam = isAdmin && body.asTeam === true;

  await prisma.feedbackComment.create({
    data: {
      feedbackId: id,
      authorId: asTeam ? null : actor.id,
      body: text.slice(0, 5000),
    },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
