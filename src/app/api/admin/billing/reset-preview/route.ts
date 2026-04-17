import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/admin/billing/reset-preview
 *
 * Returns the row counts that would be affected by a billing reset, so the
 * clean-slate modal can show factual numbers ("Invoices to delete: 47") before
 * Todd commits. Read-only, no state change.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [invoices, adjustments, timeEntries, clientsWithStripe] = await Promise.all([
    prisma.invoice.count(),
    prisma.invoiceAdjustment.count(),
    prisma.timeEntry.count(),
    prisma.client.count({ where: { stripeCustomerId: { not: null } } }),
  ]);

  return NextResponse.json({
    invoices,
    adjustments,
    timeEntries,
    clientsWithStripe,
  });
}
