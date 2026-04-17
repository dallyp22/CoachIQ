import type { Prisma } from "@/generated/prisma/client";

type Tx = Omit<Prisma.TransactionClient, "$transaction" | "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

/**
 * Allocate the next invoice number for the given year using the per-year
 * Postgres sequence created in migration 20260416_billing_overhaul.
 *
 * Atomic. Race-free. Replaces the read-then-write pattern that used to live
 * in src/app/api/invoices/generate/route.ts:59-66 and could collide under
 * concurrent cron + manual-button runs.
 *
 * MUST be called inside a transaction (the same one as the invoice INSERT)
 * so that an aborted invoice creation doesn't burn a sequence number.
 *
 * Returns: "{prefix}-{year}-{paddedSeq}" e.g. "CIQ-2026-0042"
 */
export async function allocateInvoiceNumber(
  tx: Tx,
  year: number,
  prefix: string,
  padding: number,
): Promise<string> {
  // Ensure the year's sequence exists. Idempotent CREATE SEQUENCE IF NOT EXISTS.
  await tx.$executeRawUnsafe(`SELECT ensure_invoice_seq_for_year($1)`, year);

  const rows = await tx.$queryRawUnsafe<{ nextval: bigint }[]>(
    `SELECT nextval('invoice_number_seq_${year}') AS nextval`,
  );

  const seq = Number(rows[0].nextval);
  const padded = String(seq).padStart(padding, "0");
  return `${prefix}-${year}-${padded}`;
}
