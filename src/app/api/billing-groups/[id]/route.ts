import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";
import { Decimal } from "@prisma/client/runtime/client";

/**
 * GET /api/billing-groups/[id] — full detail with members + recent invoices.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await params;
  const group = await prisma.billingGroup.findUnique({
    where: { id },
    include: {
      members: {
        select: {
          id: true,
          name: true,
          displayName: true,
          email: true,
          hourlyRate: true,
          status: true,
        },
        orderBy: { name: "asc" },
      },
      invoices: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  if (!group || !canAccess(coachId, group.coachId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...group,
    hourlyRate: group.hourlyRate ? Number(group.hourlyRate) : null,
    retainer: Number(group.retainer),
    members: group.members.map((m) => ({
      ...m,
      hourlyRate: Number(m.hourlyRate),
    })),
    invoices: group.invoices.map((i) => ({
      ...i,
      subtotal: Number(i.subtotal),
      tax: Number(i.tax),
      total: Number(i.total),
      snapshotHourlyRate: i.snapshotHourlyRate ? Number(i.snapshotHourlyRate) : null,
    })),
  });
}

/**
 * PATCH /api/billing-groups/[id] — update group fields. Snapshots on
 * existing draft/approved invoices stay frozen until the user clicks
 * "Refresh from billable" — same pattern as Client edits.
 */
export async function PATCH(
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

  const existing = await prisma.billingGroup.findUnique({
    where: { id },
    select: { coachId: true },
  });
  if (!existing || !canAccess(coachId, existing.coachId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};

  const stringFields = [
    "name", "displayName", "billingContactName", "billingContactEmail",
    "billingTimezone", "notes",
  ];
  for (const f of stringFields) {
    if (body[f] !== undefined) {
      updates[f] = body[f] === "" ? null : body[f];
    }
  }

  if (body.ccEmails !== undefined) {
    updates.ccEmails = Array.isArray(body.ccEmails)
      ? body.ccEmails.filter((e: unknown) => typeof e === "string" && e.includes("@"))
      : [];
  }
  if (body.tags !== undefined) {
    updates.tags = Array.isArray(body.tags) ? body.tags : [];
  }
  if (body.hourlyRate !== undefined) {
    updates.hourlyRate =
      body.hourlyRate === null || body.hourlyRate === ""
        ? null
        : new Decimal(body.hourlyRate);
  }
  if (body.billingCadence !== undefined) updates.billingCadence = body.billingCadence;
  if (body.customCadenceDays !== undefined) updates.customCadenceDays = body.customCadenceDays;
  if (body.status !== undefined) updates.status = body.status;
  if (body.billingPausedUntil !== undefined) {
    updates.billingPausedUntil = body.billingPausedUntil
      ? new Date(body.billingPausedUntil)
      : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, status: "no-op" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.billingGroup.update({ where: { id }, data: updates });
    await logEvent(tx, {
      event: BillingEvent.GROUP_UPDATED,
      actor: userId,
      groupId: id,
      payload: { fields: Object.keys(updates) },
    });
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/billing-groups/[id] — refuses if any non-VOID invoices exist.
 * Members get their billingGroupId nulled (FK ON DELETE SET NULL).
 */
export async function DELETE(
  _request: NextRequest,
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

  const existing = await prisma.billingGroup.findUnique({
    where: { id },
    select: { coachId: true },
  });
  if (!existing || !canAccess(coachId, existing.coachId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const blockingInvoices = await prisma.invoice.count({
    where: { groupId: id, status: { not: "VOID" } },
  });
  if (blockingInvoices > 0) {
    return NextResponse.json(
      {
        error: `Cannot delete: ${blockingInvoices} non-void invoice${blockingInvoices === 1 ? "" : "s"} reference this group. Void or reassign them first.`,
      },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.billingGroup.delete({ where: { id } });
    await logEvent(tx, {
      event: BillingEvent.GROUP_DELETED,
      actor: userId,
      groupId: id,
    });
  });

  return NextResponse.json({ ok: true });
}
