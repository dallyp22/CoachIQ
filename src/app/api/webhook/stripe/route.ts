import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

/**
 * Stripe Webhook Handler
 *
 * Handles:
 *   - invoice.paid → mark invoice + time entries as PAID
 *   - invoice.payment_failed → log error, keep as SENT
 *   - invoice.overdue → mark as OVERDUE
 */
export async function POST(request: NextRequest) {
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      payload,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    console.error("Stripe webhook signature failed:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const stripeInvoice = event.data.object as { id: string; metadata?: Record<string, string> };
  const coachiqInvoiceId = stripeInvoice.metadata?.coachiq_invoice_id;

  if (!coachiqInvoiceId) {
    // Not a CoachIQ invoice, ignore
    return NextResponse.json({ received: true });
  }

  switch (event.type) {
    case "invoice.paid": {
      await prisma.$transaction(async (tx) => {
        await tx.invoice.update({
          where: { id: coachiqInvoiceId },
          data: { status: "PAID", paidAt: new Date() },
        });
        await tx.timeEntry.updateMany({
          where: { invoiceId: coachiqInvoiceId },
          data: { status: "PAID" },
        });
      });
      console.log(`Invoice ${coachiqInvoiceId} marked PAID`);
      break;
    }

    case "invoice.payment_failed": {
      console.warn(`Payment failed for invoice ${coachiqInvoiceId}`);
      // Keep status as SENT — Stripe will retry automatically
      break;
    }

    case "invoice.overdue": {
      await prisma.invoice.update({
        where: { id: coachiqInvoiceId },
        data: { status: "OVERDUE" },
      });
      console.log(`Invoice ${coachiqInvoiceId} marked OVERDUE`);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
