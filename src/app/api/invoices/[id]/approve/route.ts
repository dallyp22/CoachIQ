import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({ where: { id } });

  if (!invoice) {
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
