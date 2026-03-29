import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

/**
 * Send an approved invoice via Stripe.
 *
 * 1. Create or retrieve Stripe Customer for the client
 * 2. Create Stripe Invoice with line items
 * 3. Finalize and send the invoice
 * 4. Update our invoice record with Stripe IDs
 *
 * POST /api/invoices/[id]/send
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { client: true },
  });

  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  if (invoice.status !== "APPROVED" && invoice.status !== "DRAFT") {
    return NextResponse.json(
      { error: `Cannot send invoice in ${invoice.status} status` },
      { status: 400 }
    );
  }

  try {
    // 1. Get or create Stripe Customer
    let stripeCustomerId = invoice.client.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({
        name: invoice.client.name,
        email: invoice.client.email,
        metadata: { coachiq_client_id: invoice.client.id },
      });
      stripeCustomerId = customer.id;

      await prisma.client.update({
        where: { id: invoice.client.id },
        data: { stripeCustomerId },
      });
    }

    // 2. Create Stripe Invoice
    const lineItems = invoice.lineItems as Array<{
      date: string;
      description: string;
      hours: number;
      rate: number;
      amount: number;
    }>;

    const stripeInvoice = await getStripe().invoices.create({
      customer: stripeCustomerId,
      collection_method: "send_invoice",
      days_until_due: 30,
      metadata: {
        coachiq_invoice_id: invoice.id,
        coachiq_invoice_number: invoice.invoiceNumber,
      },
    });

    // Add line items
    for (const item of lineItems) {
      const sessionDate = new Date(item.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      await getStripe().invoiceItems.create({
        customer: stripeCustomerId,
        invoice: stripeInvoice.id,
        description: `${item.description} (${sessionDate}) — ${item.hours.toFixed(2)} hrs @ $${item.rate}/hr`,
        amount: Math.round(item.amount * 100), // Stripe uses cents
        currency: "usd",
      });
    }

    // 3. Finalize and send
    const finalized = await getStripe().invoices.finalizeInvoice(stripeInvoice.id);
    await getStripe().invoices.sendInvoice(stripeInvoice.id);

    // 4. Update our records
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id },
        data: {
          status: "SENT",
          stripeInvoiceId: stripeInvoice.id,
          stripePaymentUrl: finalized.hosted_invoice_url || null,
          sentAt: new Date(),
        },
      });

      await tx.timeEntry.updateMany({
        where: { invoiceId: id },
        data: { status: "INVOICED" },
      });
    });

    return NextResponse.json({
      status: "sent",
      stripeInvoiceId: stripeInvoice.id,
      paymentUrl: finalized.hosted_invoice_url,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe error";
    console.error("Stripe send error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
