import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { requireCoach, authzResponse } from "@/lib/authz";

interface ResetBody {
  confirm?: string;
  keepStripeCustomers?: boolean;
}

/**
 * POST /api/admin/billing/reset
 *
 * Wipes all invoices + invoice adjustments, resets every TimeEntry to UNBILLED.
 * Optionally clears stripeCustomerId on every Client.
 *
 * Body MUST include `confirm: "RESET"` (typed-confirmation matched here AND in
 * the UI modal). `keepStripeCustomers` defaults to true — preserves customers
 * + their payment methods, just removes our internal billing state.
 *
 * Wrapped in a single transaction so partial failure leaves the DB unchanged.
 * Logs a RESET event to billing_audit_logs with counts of what was wiped.
 *
 * Auth: OWNER only — this wipes billing state across the whole practice, so
 * there is no coach-scoped version of it. The userId is captured alongside for
 * the audit log actor field.
 */
export async function POST(request: NextRequest) {
  try {
    await requireCoach("OWNER");
  } catch (err) {
    return authzResponse(err);
  }
  const { userId } = await auth();

  let body: ResetBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.confirm !== "RESET") {
    return NextResponse.json(
      { error: "Confirmation phrase missing or incorrect" },
      { status: 400 },
    );
  }

  const keepStripeCustomers = body.keepStripeCustomers ?? true;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const counts = {
        invoices: await tx.invoice.count(),
        adjustments: await tx.invoiceAdjustment.count(),
        timeEntries: await tx.timeEntry.count(),
        clientsWithStripe: keepStripeCustomers
          ? 0
          : await tx.client.count({ where: { stripeCustomerId: { not: null } } }),
      };

      // Order matters: adjustments → invoices → time entries
      await tx.invoiceAdjustment.deleteMany({});
      await tx.invoice.deleteMany({});
      await tx.timeEntry.updateMany({
        data: { status: "UNBILLED", invoiceId: null },
      });
      await tx.client.updateMany({
        data: { nextInvoiceDueAt: null },
      });
      if (!keepStripeCustomers) {
        await tx.client.updateMany({ data: { stripeCustomerId: null } });
      }

      await logEvent(tx, {
        event: BillingEvent.RESET,
        actor: userId,
        payload: { counts, keepStripeCustomers },
      });

      return counts;
    });

    return NextResponse.json({
      ok: true,
      message: `Reset complete. Wiped ${result.invoices} invoices and reset ${result.timeEntries} time entries.`,
      counts: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reset failed";
    console.error("[billing reset] error:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}
