import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Generate draft invoices from unbilled time entries.
 *
 * Groups unbilled entries by client, creates a draft Invoice for each
 * client that has unbilled work. Idempotent — skips clients that already
 * have a DRAFT invoice for the current period.
 *
 * POST /api/invoices/generate
 */
export async function POST() {
  // Get all clients with unbilled time entries
  const clients = await prisma.client.findMany({
    where: {
      timeEntries: { some: { status: "UNBILLED" } },
    },
    include: {
      timeEntries: {
        where: { status: "UNBILLED" },
        orderBy: { date: "asc" },
      },
    },
  });

  if (clients.length === 0) {
    return NextResponse.json({ created: 0, message: "No unbilled time entries" });
  }

  let created = 0;

  for (const client of clients) {
    // Check if client already has a DRAFT invoice (don't duplicate)
    const existingDraft = await prisma.invoice.findFirst({
      where: { clientId: client.id, status: "DRAFT" },
    });
    if (existingDraft) continue;

    const entries = client.timeEntries;
    if (entries.length === 0) continue;

    // Calculate totals
    const lineItems = entries.map((e) => ({
      date: e.date.toISOString(),
      description: e.description || "Coaching session",
      hours: Number(e.billableHours),
      rate: Number(e.hourlyRate),
      amount: Number(e.amount),
      timeEntryId: e.id,
    }));

    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
    const periodStart = entries[0].date;
    const periodEnd = entries[entries.length - 1].date;

    // Generate invoice number: CIQ-YYYY-NNNN
    const year = new Date().getFullYear();
    const lastInvoice = await prisma.invoice.findFirst({
      where: { invoiceNumber: { startsWith: `CIQ-${year}` } },
      orderBy: { invoiceNumber: "desc" },
    });
    const seq = lastInvoice
      ? parseInt(lastInvoice.invoiceNumber.split("-")[2]) + 1
      : 1;
    const invoiceNumber = `CIQ-${year}-${String(seq).padStart(4, "0")}`;

    // Create invoice and stage time entries in a transaction
    await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          clientId: client.id,
          invoiceNumber,
          periodStart,
          periodEnd,
          lineItems: lineItems as unknown as object,
          subtotal,
          tax: 0,
          total: subtotal,
          status: "DRAFT",
        },
      });

      // Mark time entries as STAGED
      await tx.timeEntry.updateMany({
        where: {
          id: { in: entries.map((e) => e.id) },
        },
        data: {
          status: "STAGED",
          invoiceId: invoice.id,
        },
      });
    });

    created++;
  }

  return NextResponse.json({
    created,
    message: `${created} draft invoice(s) generated`,
  });
}
