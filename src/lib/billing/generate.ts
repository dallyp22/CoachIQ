import { prisma } from "@/lib/db";
import type { Prisma, BillingCadence } from "@/generated/prisma/client";
import { Decimal } from "@prisma/client/runtime/client";
import { snapshotClient } from "./snapshot";
import { allocateInvoiceNumber } from "./numbering";
import { nextCadenceDate, advanceUntilFuture, type CadenceOpts } from "./cadence";
import { logEvent, BillingEvent } from "./audit";

type Tx = Omit<Prisma.TransactionClient, "$transaction" | "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

export interface GenerateResult {
  status: "created" | "skipped:paused" | "skipped:no_work" | "skipped:not_due" | "skipped:lock";
  invoiceId?: string;
  invoiceNumber?: string;
  total?: number;
  reason?: string;
}

export interface GenerateOpts {
  source: "cron" | "manual";
  actor?: string | null;
  /** Override "now" for testing. Defaults to new Date(). */
  now?: Date;
  /** Force generation regardless of nextInvoiceDueAt (used by manual button). */
  ignoreSchedule?: boolean;
}

/**
 * Generate a single invoice for a single client. The shared core called by
 * both the cron and the manual "Generate Draft Invoices" button.
 *
 * Flow:
 *  1. pg_try_advisory_xact_lock — skip if another generator owns this client
 *  2. skip if billingPausedUntil > now
 *  3. skip if nextInvoiceDueAt > now (unless ignoreSchedule)
 *  4. fetch unbilled time entries
 *  5. snapshot client fields
 *  6. compose line items (sessions + retainer line if balance > 0)
 *  7. allocate invoice number from per-year sequence
 *  8. apply auto-approve if total < threshold
 *  9. create invoice + flip time entries to STAGED
 * 10. advance nextInvoiceDueAt to next cadence date (with drift recovery)
 * 11. audit
 *
 * Caller passes their own transaction so the entire generation is atomic.
 */
export async function generateInvoiceForClient(
  tx: Tx,
  clientId: string,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const now = opts.now ?? new Date();

  // 1. Per-client advisory lock. hashtext gives us a stable int from the UUID.
  const lockRows = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
    clientId,
  );
  if (!lockRows[0]?.acquired) {
    return { status: "skipped:lock" };
  }

  const client = await tx.client.findUnique({ where: { id: clientId } });
  if (!client) {
    throw new Error(`Client ${clientId} not found`);
  }

  // 2. Paused?
  if (client.billingPausedUntil && client.billingPausedUntil.getTime() > now.getTime()) {
    await logEvent(tx, {
      event: BillingEvent.CRON_GEN,
      actor: opts.actor,
      clientId,
      payload: { skipped: "paused", until: client.billingPausedUntil.toISOString() },
    });
    return { status: "skipped:paused" };
  }

  // 3. Due?
  if (
    !opts.ignoreSchedule &&
    client.nextInvoiceDueAt &&
    client.nextInvoiceDueAt.getTime() > now.getTime()
  ) {
    return { status: "skipped:not_due" };
  }

  // Coach-wide settings for defaults
  const settings = await tx.coachSettings.findFirst();
  const timezone = client.billingTimezone ?? settings?.timezone ?? "America/Chicago";
  const cadenceOpts: CadenceOpts = {
    cadence: client.billingCadence,
    customCadenceDays: client.customCadenceDays,
    defaultBillingDayOfMonth: settings?.defaultBillingDayOfMonth ?? null,
    timezone,
  };

  // 4. Unbilled entries up to "now"
  const unbilledEntries = await tx.timeEntry.findMany({
    where: { clientId, status: "UNBILLED", date: { lte: now } },
    orderBy: { date: "asc" },
  });

  if (unbilledEntries.length === 0) {
    // No work to bill — still advance the schedule cursor so we don't
    // re-evaluate this client every cron tick until they get a session.
    const nextDue = client.nextInvoiceDueAt
      ? advanceUntilFuture(client.nextInvoiceDueAt, now, cadenceOpts)
      : nextCadenceDate(now, cadenceOpts);
    await tx.client.update({
      where: { id: clientId },
      data: { nextInvoiceDueAt: nextDue },
    });
    await logEvent(tx, {
      event: BillingEvent.CRON_GEN,
      actor: opts.actor,
      clientId,
      payload: { skipped: "no_work", advancedTo: nextDue.toISOString() },
    });
    return { status: "skipped:no_work" };
  }

  // 5. Snapshot
  const snapshot = snapshotClient(client);

  // 6. Compose line items. Existing format on Invoice.lineItems is JSON.
  type LineItem = {
    date: string;
    description: string;
    hours: number;
    rate: number;
    amount: number;
    timeEntryId?: string;
  };
  const lineItems: LineItem[] = unbilledEntries.map((e) => ({
    date: e.date.toISOString(),
    description: e.description ?? "Coaching session",
    hours: Number(e.billableHours),
    rate: Number(e.hourlyRate),
    amount: Number(e.amount),
    timeEntryId: e.id,
  }));

  let subtotal = unbilledEntries.reduce(
    (sum, e) => sum.plus(e.amount),
    new Decimal(0),
  );

  // Retainer: apply as a negative line item, capped at the subtotal so the
  // invoice can't go negative. Carry remaining balance forward.
  let retainerApplied = new Decimal(0);
  if (client.retainer && client.retainer.greaterThan(0)) {
    retainerApplied = Decimal.min(client.retainer, subtotal);
    if (retainerApplied.greaterThan(0)) {
      lineItems.push({
        date: now.toISOString(),
        description: "Retainer applied",
        hours: 0,
        rate: 0,
        amount: -Number(retainerApplied),
      });
      subtotal = subtotal.minus(retainerApplied);
    }
  }

  const total = subtotal;

  // 7. Allocate invoice number from per-year sequence
  const year = now.getUTCFullYear();
  const prefix = settings?.invoicePrefix ?? "CIQ";
  const padding = settings?.invoiceNumberPadding ?? 4;
  const invoiceNumber = await allocateInvoiceNumber(tx, year, prefix, padding);

  // 8. Auto-approve threshold
  const autoApproveCents = settings?.autoApproveUnderCents ?? null;
  const totalCents = total.times(100).toNumber();
  const status =
    autoApproveCents !== null && totalCents < autoApproveCents ? "APPROVED" : "DRAFT";

  // 9. Create invoice + flip time entries
  const periodStart = unbilledEntries[0].date;
  const periodEnd = unbilledEntries[unbilledEntries.length - 1].date;

  const invoice = await tx.invoice.create({
    data: {
      clientId,
      invoiceNumber,
      periodStart,
      periodEnd,
      lineItems: lineItems as unknown as Prisma.InputJsonValue,
      subtotal: total,
      tax: new Decimal(0),
      total,
      status,
      snapshotClientName: snapshot.snapshotClientName,
      snapshotBillingEmail: snapshot.snapshotBillingEmail,
      snapshotBillingCcEmails: snapshot.snapshotBillingCcEmails,
      snapshotHourlyRate: snapshot.snapshotHourlyRate,
    },
  });

  await tx.timeEntry.updateMany({
    where: { id: { in: unbilledEntries.map((e) => e.id) } },
    data: { status: "STAGED", invoiceId: invoice.id },
  });

  // Persist retainer reduction
  if (retainerApplied.greaterThan(0)) {
    await tx.client.update({
      where: { id: clientId },
      data: { retainer: client.retainer.minus(retainerApplied) },
    });
    await logEvent(tx, {
      event: BillingEvent.RETAINER_APPLY,
      actor: opts.actor,
      clientId,
      invoiceId: invoice.id,
      payload: { applied: Number(retainerApplied), remaining: Number(client.retainer.minus(retainerApplied)) },
    });
  }

  // 10. Advance schedule cursor
  const nextDue = client.nextInvoiceDueAt
    ? advanceUntilFuture(client.nextInvoiceDueAt, now, cadenceOpts)
    : nextCadenceDate(now, cadenceOpts);
  await tx.client.update({
    where: { id: clientId },
    data: { nextInvoiceDueAt: nextDue },
  });

  // 11. Audit
  await logEvent(tx, {
    event: status === "APPROVED" ? BillingEvent.INVOICE_APPROVED : BillingEvent.INVOICE_DRAFT,
    actor: opts.actor,
    clientId,
    invoiceId: invoice.id,
    payload: {
      source: opts.source,
      total: Number(total),
      lineCount: lineItems.length,
      retainerApplied: Number(retainerApplied),
    },
  });

  return {
    status: "created",
    invoiceId: invoice.id,
    invoiceNumber,
    total: Number(total),
  };
}

export interface GenerateAllResult {
  total: number;
  created: number;
  skipped: { paused: number; no_work: number; not_due: number; lock: number };
  invoices: { clientId: string; invoiceId: string; invoiceNumber: string; total: number }[];
  errors: { clientId: string; message: string }[];
}

/**
 * Iterate all active clients and generate invoices for those who are due.
 * Each client gets its own transaction so a single failure doesn't roll back
 * the whole run.
 */
export async function generateForAllDueClients(
  opts: GenerateOpts,
): Promise<GenerateAllResult> {
  const result: GenerateAllResult = {
    total: 0,
    created: 0,
    skipped: { paused: 0, no_work: 0, not_due: 0, lock: 0 },
    invoices: [],
    errors: [],
  };

  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  result.total = clients.length;

  for (const c of clients) {
    try {
      const r = await prisma.$transaction((tx) =>
        generateInvoiceForClient(tx as Tx, c.id, opts),
      );
      if (r.status === "created" && r.invoiceId && r.invoiceNumber && r.total !== undefined) {
        result.created++;
        result.invoices.push({
          clientId: c.id,
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber,
          total: r.total,
        });
      } else if (r.status === "skipped:paused") result.skipped.paused++;
      else if (r.status === "skipped:no_work") result.skipped.no_work++;
      else if (r.status === "skipped:not_due") result.skipped.not_due++;
      else if (r.status === "skipped:lock") result.skipped.lock++;
    } catch (err) {
      result.errors.push({
        clientId: c.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
