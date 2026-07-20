import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";

interface AdjustBody {
  kind?: "credit" | "discount" | "expense";
  amount?: number | string;
  description?: string;
}

const VALID_KINDS = new Set(["credit", "discount", "expense"]);

/**
 * POST /api/invoices/[id]/adjust
 *
 * Add a credit, discount, or expense line to an invoice. Adjustments are
 * stored as their own rows (InvoiceAdjustment) AND mirrored as a line item
 * in the invoice JSON so the existing render path picks them up.
 *
 * Convention:
 *   - credit / discount → amount must be NEGATIVE (caller responsibility)
 *   - expense           → amount must be POSITIVE
 *
 * Blocked on SENT / PAID / VOID. Use the credit memo workflow (TODO) for those.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }
  // Audit rows record the Clerk account that acted, not the coach it resolves to.
  const { userId } = await auth();

  const { id } = await params;

  let body: AdjustBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.kind || !VALID_KINDS.has(body.kind)) {
    return NextResponse.json(
      { error: "kind must be one of: credit, discount, expense" },
      { status: 400 },
    );
  }
  if (body.amount === undefined || body.amount === null) {
    return NextResponse.json({ error: "amount is required" }, { status: 400 });
  }
  if (!body.description || body.description.trim().length === 0) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }

  let amount: Decimal;
  try {
    amount = new Decimal(body.amount);
  } catch {
    return NextResponse.json({ error: "amount must be a valid number" }, { status: 400 });
  }

  // Sign convention check
  if ((body.kind === "credit" || body.kind === "discount") && amount.greaterThanOrEqualTo(0)) {
    return NextResponse.json(
      { error: `${body.kind} amount must be negative` },
      { status: 400 },
    );
  }
  if (body.kind === "expense" && amount.lessThanOrEqualTo(0)) {
    return NextResponse.json(
      { error: "expense amount must be positive" },
      { status: 400 },
    );
  }

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

  if (invoice.status === "SENT" || invoice.status === "PAID" || invoice.status === "VOID") {
    return NextResponse.json(
      {
        error: `Cannot adjust ${invoice.status} invoice. Use credit memo workflow for post-send changes.`,
      },
      { status: 400 },
    );
  }

  const newTotal = invoice.total.plus(amount);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const adjustment = await tx.invoiceAdjustment.create({
        data: {
          invoiceId: id,
          kind: body.kind!,
          amount,
          description: body.description!,
        },
      });

      // Mirror into lineItems JSON so the existing render reads it
      type LineItem = {
        date: string;
        description: string;
        hours: number;
        rate: number;
        amount: number;
        timeEntryId?: string;
        adjustmentId?: string;
      };
      const items = (invoice.lineItems as unknown as LineItem[]) ?? [];
      items.push({
        date: new Date().toISOString(),
        description: body.description!,
        hours: 0,
        rate: 0,
        amount: Number(amount),
        adjustmentId: adjustment.id,
      });

      await tx.invoice.update({
        where: { id },
        data: {
          lineItems: items as unknown as object,
          subtotal: newTotal,
          total: newTotal,
        },
      });

      await logEvent(tx, {
        event: BillingEvent.INVOICE_ADJUSTED,
        actor: userId,
        clientId: invoice.clientId,
        invoiceId: id,
        payload: {
          kind: body.kind,
          amount: Number(amount),
          description: body.description,
          newTotal: Number(newTotal),
        },
      });

      return adjustment;
    });

    return NextResponse.json({
      ok: true,
      adjustmentId: result.id,
      newTotal: Number(newTotal),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Adjustment failed";
    console.error("[invoice adjust] error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
