import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";

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
    include: { client: true, group: true },
  });

  const invoiceCoachId = invoice?.client?.coachId ?? invoice?.group?.coachId ?? null;
  if (!invoice || !canAccess(coachId, invoiceCoachId)) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  if (invoice.status !== "APPROVED" && invoice.status !== "DRAFT") {
    return NextResponse.json(
      { error: `Cannot send invoice in ${invoice.status} status` },
      { status: 400 }
    );
  }

  // The invoice_billable_xor CHECK constraint guarantees exactly one of
  // client / group is set. Narrow the type for TypeScript and pull the
  // billing entity out for snapshot defaulting + Stripe customer caching.
  const isGroup = invoice.group !== null;
  if (!isGroup && !invoice.client) {
    return NextResponse.json(
      { error: "Invoice has neither client nor group; data integrity violation" },
      { status: 500 }
    );
  }

  try {
    // 1. Get or create Stripe Customer using SNAPSHOT fields, not live data.
    // Snapshots are taken at draft creation and frozen until "Refresh from
    // billable" is clicked — this guarantees the Stripe customer/invoice
    // match what Todd reviewed in the draft, not whatever the source record
    // looks like right now (which may have drifted post-snapshot).
    const fallbackName = isGroup ? invoice.group!.name : invoice.client!.name;
    const fallbackEmail = isGroup
      ? invoice.group!.billingContactEmail
      : invoice.client!.email;
    const billingName = invoice.snapshotClientName ?? fallbackName;
    const billingEmail = invoice.snapshotBillingEmail ?? fallbackEmail;
    const billingCcEmails = invoice.snapshotBillingCcEmails ?? [];

    let stripeCustomerId = isGroup
      ? invoice.group!.stripeCustomerId
      : invoice.client!.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({
        name: billingName,
        email: billingEmail,
        metadata: isGroup
          ? { coachiq_group_id: invoice.group!.id }
          : { coachiq_client_id: invoice.client!.id },
      });
      stripeCustomerId = customer.id;

      if (isGroup) {
        await prisma.billingGroup.update({
          where: { id: invoice.group!.id },
          data: { stripeCustomerId },
        });
      } else {
        await prisma.client.update({
          where: { id: invoice.client!.id },
          data: { stripeCustomerId },
        });
      }
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
      // Stripe sends the invoice email to the customer's primary email; CC
      // emails get added as custom fields visible on the hosted invoice page.
      // (Stripe API does not expose a true "BCC" — custom fields are the
      // closest thing while keeping addresses visible to the recipient.)
      custom_fields: billingCcEmails.length > 0
        ? [{ name: "CC", value: billingCcEmails.join(", ") }]
        : undefined,
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
