import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";

/**
 * GET /api/admin/billing/reset-preview
 *
 * Returns the row counts that would be affected by a billing reset, so the
 * clean-slate modal can show factual numbers ("Invoices to delete: 47") before
 * Todd commits. Read-only, no state change.
 */
export async function GET() {
  try {
    await requireCoach("OWNER");
  } catch (err) {
    return authzResponse(err);
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
