import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";

/**
 * POST /api/billing-groups/[id]/members
 * Body: { clientId: string }
 * Sets client.billingGroupId = id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const clientId = body.clientId;

  if (typeof clientId !== "string") {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const group = await prisma.billingGroup.findUnique({ where: { id } });
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

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
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const clientId = body.clientId;

  if (typeof clientId !== "string") {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const r = await prisma.$transaction(async (tx) => {
    const updated = await tx.client.updateMany({
      where: { id: clientId, billingGroupId: id },
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
