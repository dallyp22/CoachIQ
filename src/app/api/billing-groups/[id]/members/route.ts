import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";

/**
 * POST /api/billing-groups/[id]/members
 * Body: { clientId: string }
 * Sets client.billingGroupId = id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }
  // Audit rows record the Clerk account that acted, not the coach it resolves to.
  const { userId } = await auth();

  const { id } = await params;
  const body = await request.json();
  const clientId = body.clientId;

  if (typeof clientId !== "string") {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const group = await prisma.billingGroup.findUnique({ where: { id } });
  if (!group || !canAccess(coachId, group.coachId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || !canAccess(coachId, client.coachId)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // One-coach-per-group: a group's invoices are billed under a single coach,
  // so a member from another coach's book would silently cross the boundary.
  // This also holds for an OWNER/ADMIN acting unscoped, hence the direct
  // comparison rather than a canAccess check.
  if (client.coachId !== group.coachId) {
    return NextResponse.json(
      { error: "Client belongs to a different coach than this billing group" },
      { status: 400 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.client.update({
      where: { id: clientId },
      data: { billingGroupId: id },
    });
    await logEvent(tx, {
      event: BillingEvent.GROUP_MEMBER_ADDED,
      actor: userId,
      clientId,
      groupId: id,
      payload: { previousGroupId: client.billingGroupId },
    });
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/billing-groups/[id]/members
 * Body: { clientId: string }
 * Nulls client.billingGroupId (only if it currently equals id, no-ops otherwise).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }
  // Audit rows record the Clerk account that acted, not the coach it resolves to.
  const { userId } = await auth();

  const { id } = await params;
  const body = await request.json();
  const clientId = body.clientId;

  if (typeof clientId !== "string") {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const group = await prisma.billingGroup.findUnique({
    where: { id },
    select: { coachId: true },
  });
  if (!group || !canAccess(coachId, group.coachId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const r = await prisma.$transaction(async (tx) => {
    // The coachId predicate keeps the removal a no-op (removed: 0) rather than
    // a 404 when the client is out of scope — same shape as "wasn't a member".
    const updated = await tx.client.updateMany({
      where: { id: clientId, billingGroupId: id, ...(coachId ? { coachId } : {}) },
      data: { billingGroupId: null },
    });
    if (updated.count > 0) {
      await logEvent(tx, {
        event: BillingEvent.GROUP_MEMBER_REMOVED,
        actor: userId,
        clientId,
        groupId: id,
      });
    }
    return updated;
  });

  return NextResponse.json({ ok: true, removed: r.count });
}
