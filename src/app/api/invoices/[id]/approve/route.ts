import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";

/**
 * Approve a draft invoice.
 * Transitions: DRAFT → APPROVED
 * Updates associated TimeEntries: STAGED → INVOICED
 *
 * POST /api/invoices/[id]/approve
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: { select: { coachId: true } },
      group: { select: { coachId: true } },
    },
  });

  const invoiceCoachId = invoice?.client?.coachId ?? invoice?.group?.coachId ?? null;
  if (!invoice || !canAccess(coachId, invoiceCoachId)) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  if (invoice.status !== "DRAFT") {
    return NextResponse.json(
      { error: `Cannot approve invoice in ${invoice.status} status` },
      { status: 400 }
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id },
      data: { status: "APPROVED" },
    });

    await tx.timeEntry.updateMany({
      where: { invoiceId: id, status: "STAGED" },
      data: { status: "INVOICED" },
    });
  });

  return NextResponse.json({ status: "approved", invoiceId: id });
}
