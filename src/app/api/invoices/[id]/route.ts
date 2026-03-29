import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Update a draft invoice — edit line items, notes, amounts.
 *
 * PATCH /api/invoices/[id]
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (invoice.status !== "DRAFT") {
    return NextResponse.json(
      { error: `Cannot edit invoice in ${invoice.status} status` },
      { status: 400 }
    );
  }

  const updates: Record<string, unknown> = {};

  if (body.lineItems !== undefined) {
    updates.lineItems = body.lineItems;
    const subtotal = (body.lineItems as Array<{ amount: number }>).reduce(
      (sum: number, item: { amount: number }) => sum + item.amount,
      0
    );
    updates.subtotal = subtotal;
    updates.total = subtotal + Number(invoice.tax);
  }

  if (body.notes !== undefined) {
    updates.notes = body.notes;
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: updates,
  });

  return NextResponse.json({ status: "updated", invoice: updated });
}

/**
 * Delete a draft invoice — returns time entries to UNBILLED.
 *
 * DELETE /api/invoices/[id]
 */
export async function DELETE(
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
      { error: `Cannot delete invoice in ${invoice.status} status` },
      { status: 400 }
    );
  }

  await prisma.$transaction(async (tx) => {
    // Return time entries to UNBILLED
    await tx.timeEntry.updateMany({
      where: { invoiceId: id },
      data: { status: "UNBILLED", invoiceId: null },
    });

    await tx.invoice.delete({ where: { id } });
  });

  return NextResponse.json({ status: "deleted" });
}
