import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { snapshotBillable } from "@/lib/billing/snapshot";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";

/**
 * POST /api/invoices/[id]/refresh-from-client
 *
 * Re-snapshots client billing fields onto the invoice. Allowed for DRAFT and
 * APPROVED invoices only — once an invoice is SENT/PAID/VOID, the snapshot
 * is immutable so historical records stay accurate.
 *
 * Triggered by the "Refresh from client →" affordance inside the snapshot
 * banner on draft invoice cards (only rendered when drift is detected).
 */
export async function POST(
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

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { client: true, group: { include: { members: true } } },
  });
  const invoiceCoachId = invoice?.client?.coachId ?? invoice?.group?.coachId ?? null;
  if (!invoice || !canAccess(coachId, invoiceCoachId)) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  if (invoice.status !== "DRAFT" && invoice.status !== "APPROVED") {
    return NextResponse.json(
      {
        error: `Cannot refresh snapshot on ${invoice.status} invoice — snapshots are immutable after send`,
      },
      { status: 400 },
    );
  }

  const billable = invoice.group
    ? { kind: "group" as const, group: invoice.group, members: invoice.group.members }
    : invoice.client
      ? { kind: "client" as const, client: invoice.client }
      : null;
  if (!billable) {
    return NextResponse.json(
      { error: "Invoice has neither client nor group; data integrity violation" },
      { status: 500 },
    );
  }
  const snapshot = snapshotBillable(billable);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id },
        data: {
          snapshotClientName: snapshot.snapshotClientName,
          snapshotBillingEmail: snapshot.snapshotBillingEmail,
          snapshotBillingCcEmails: snapshot.snapshotBillingCcEmails,
          snapshotHourlyRate: snapshot.snapshotHourlyRate,
        },
      });
      await logEvent(tx, {
        event: BillingEvent.INVOICE_REFRESHED,
        actor: userId,
        clientId: invoice.clientId,
        groupId: invoice.groupId,
        invoiceId: id,
        payload: {
          newName: snapshot.snapshotClientName,
          newEmail: snapshot.snapshotBillingEmail,
        },
      });
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refresh failed";
    console.error("[invoice refresh] error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
