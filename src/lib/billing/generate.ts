import { prisma } from "@/lib/db";
import type { BillingGroup, Client, Prisma, TimeEntry } from "@/generated/prisma/client";
import { Decimal } from "@prisma/client/runtime/client";
import { snapshotBillable, type Billable } from "./snapshot";
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

interface BillableContext {
  /** Stable id used for the advisory lock and audit logging. */
  billableId: string;
  /** Logged on the audit row alongside billableId. */
  auditClientId: string | null;
  auditGroupId: string | null;
  /** Identifying fields for log payloads. */
  displayName: string;
  /** Cadence inputs. */
  cadenceOpts: CadenceOpts;
  billingTimezone: string;
  /** Schedule cursor + pause window (live, current values). */
  billingPausedUntil: Date | null;
  nextInvoiceDueAt: Date | null;
  /** Money. */
  retainer: Decimal;
  /** Optional rate override applied to ALL line items when set. */
  rateOverride: Decimal | null;
  /** Update fns to mutate schedule + retainer back onto the source row. */
  updateNextInvoiceDueAt: (tx: Tx, when: Date) => Promise<void>;
  updateRetainer: (tx: Tx, balance: Decimal) => Promise<void>;
  /** The Invoice row uses one or the other; never both. */
  invoiceFK: { clientId: string; groupId?: undefined } | { clientId?: undefined; groupId: string };
  /** Filter for unbilled time entries belonging to this billable. */
  unbilledFilter: Prisma.TimeEntryWhereInput;
}

/**
 * Build a unified context for either a solo client or a billing group. The
 * generation core no longer cares which kind it's working with — all the
 * differences are localized here.
 */
function billableContext(billable: Billable, defaultBillingDayOfMonth: number | null, defaultTz: string): BillableContext {
  if (billable.kind === "client") {
    const c = billable.client;
    const tz = c.billingTimezone ?? defaultTz;
    return {
      billableId: c.id,
      auditClientId: c.id,
      auditGroupId: null,
      displayName: c.displayName ?? c.name,
      cadenceOpts: {
        cadence: c.billingCadence,
        customCadenceDays: c.customCadenceDays,
        defaultBillingDayOfMonth,
        timezone: tz,
      },
      billingTimezone: tz,
      billingPausedUntil: c.billingPausedUntil,
      nextInvoiceDueAt: c.nextInvoiceDueAt,
      retainer: c.retainer,
      rateOverride: null,
      updateNextInvoiceDueAt: async (tx, when) => {
        await tx.client.update({ where: { id: c.id }, data: { nextInvoiceDueAt: when } });
      },
      updateRetainer: async (tx, balance) => {
        await tx.client.update({ where: { id: c.id }, data: { retainer: balance } });
      },
      invoiceFK: { clientId: c.id },
      unbilledFilter: { clientId: c.id, status: "UNBILLED" },
    };
  }
  const g = billable.group;
  const tz = g.billingTimezone ?? defaultTz;
  const memberIds = billable.members.map((m) => m.id);
  return {
    billableId: g.id,
    auditClientId: null,
    auditGroupId: g.id,
    displayName: g.displayName ?? g.name,
    cadenceOpts: {
      cadence: g.billingCadence,
      customCadenceDays: g.customCadenceDays,
      defaultBillingDayOfMonth,
      timezone: tz,
    },
    billingTimezone: tz,
    billingPausedUntil: g.billingPausedUntil,
    nextInvoiceDueAt: g.nextInvoiceDueAt,
    retainer: g.retainer,
    rateOverride: g.hourlyRate,
    updateNextInvoiceDueAt: async (tx, when) => {
      await tx.billingGroup.update({ where: { id: g.id }, data: { nextInvoiceDueAt: when } });
    },
    updateRetainer: async (tx, balance) => {
      await tx.billingGroup.update({ where: { id: g.id }, data: { retainer: balance } });
    },
    invoiceFK: { groupId: g.id },
    unbilledFilter:
      memberIds.length > 0
        ? { clientId: { in: memberIds }, status: "UNBILLED" }
        : { clientId: { in: ["00000000-0000-0000-0000-000000000000"] }, status: "UNBILLED" },
  };
}

/**
 * Generate a single invoice for a single billable (client OR group).
 *
 * Flow (unchanged from the per-client version, just parameterized):
 *  1. pg_try_advisory_xact_lock — skip if another generator owns this billable
 *  2. skip if billingPausedUntil > now
 *  3. skip if nextInvoiceDueAt > now (unless ignoreSchedule)
 *  4. fetch unbilled time entries (member-set if group, single-client if solo)
 *  5. snapshot billable identity
 *  6. compose line items (per-line rate; group-level rateOverride wins if set)
 *  7. allocate invoice number from per-year sequence
 *  8. apply auto-approve if total < threshold
 *  9. create invoice + flip time entries to STAGED
 * 10. advance nextInvoiceDueAt with drift recovery
 * 11. audit
 */
export async function generateInvoiceForBillable(
  tx: Tx,
  billable: Billable,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const now = opts.now ?? new Date();
  const settings = await tx.coachSettings.findFirst();
  const ctx = billableContext(
    billable,
    settings?.defaultBillingDayOfMonth ?? null,
    settings?.timezone ?? "America/Chicago",
  );

  // 1. Per-billable advisory lock. hashtext gives us a stable int from the UUID.
  const lockRows = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
    ctx.billableId,
  );
  if (!lockRows[0]?.acquired) {
    return { status: "skipped:lock" };
  }

  // 2. Paused?
  if (ctx.billingPausedUntil && ctx.billingPausedUntil.getTime() > now.getTime()) {
    await logEvent(tx, {
      event: BillingEvent.CRON_GEN,
      actor: opts.actor,
      clientId: ctx.auditClientId,
      groupId: ctx.auditGroupId,
      payload: { skipped: "paused", until: ctx.billingPausedUntil.toISOString() },
    });
    return { status: "skipped:paused" };
  }

  // 3. Due?
  if (
    !opts.ignoreSchedule &&
    ctx.nextInvoiceDueAt &&
    ctx.nextInvoiceDueAt.getTime() > now.getTime()
  ) {
    return { status: "skipped:not_due" };
  }

  // 4. Unbilled entries up to "now" for this billable
  const unbilledEntries = await tx.timeEntry.findMany({
    where: { ...ctx.unbilledFilter, date: { lte: now } },
    orderBy: { date: "asc" },
  });

  if (unbilledEntries.length === 0) {
    // No work to bill — still advance the schedule cursor so we don't
    // re-evaluate this billable every cron tick until they get a session.
    const nextDue = ctx.nextInvoiceDueAt
      ? advanceUntilFuture(ctx.nextInvoiceDueAt, now, ctx.cadenceOpts)
      : nextCadenceDate(now, ctx.cadenceOpts);
    await ctx.updateNextInvoiceDueAt(tx, nextDue);
    await logEvent(tx, {
      event: BillingEvent.CRON_GEN,
      actor: opts.actor,
      clientId: ctx.auditClientId,
      groupId: ctx.auditGroupId,
      payload: { skipped: "no_work", advancedTo: nextDue.toISOString() },
    });
    return { status: "skipped:no_work" };
  }

  // 5. Snapshot
  const snapshot = snapshotBillable(billable);

  // 6. Compose line items. Per-client rate preserved unless a group-level
  // rateOverride is set, in which case it applies to every line.
  type LineItem = {
    date: string;
    description: string;
    hours: number;
    rate: number;
    amount: number;
    timeEntryId?: string;
    clientId?: string;
  };
  const lineItems: LineItem[] = unbilledEntries.map((e) => {
    const rate = ctx.rateOverride ?? new Decimal(e.hourlyRate);
    const hours = new Decimal(e.billableHours);
    const amount = rate.times(hours);
    return {
      date: e.date.toISOString(),
      description: e.description ?? "Coaching session",
      hours: Number(hours),
      rate: Number(rate),
      amount: Number(amount),
      timeEntryId: e.id,
      // Tag the line with its client so group invoices can render "Sarah / Mike / Joel" attribution
      clientId: billable.kind === "group" ? e.clientId : undefined,
    };
  });

  let subtotal = lineItems.reduce(
    (sum, li) => sum.plus(new Decimal(li.amount)),
    new Decimal(0),
  );

  // Retainer: apply as a negative line item, capped at the subtotal so the
  // invoice can't go negative. Carry remaining balance forward.
  let retainerApplied = new Decimal(0);
  if (ctx.retainer && ctx.retainer.greaterThan(0)) {
    retainerApplied = Decimal.min(ctx.retainer, subtotal);
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
      ...ctx.invoiceFK,
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
    where: { id: { in: unbilledEntries.map((e: TimeEntry) => e.id) } },
    data: { status: "STAGED", invoiceId: invoice.id },
  });

  // Persist retainer reduction on the source row (client OR group)
  if (retainerApplied.greaterThan(0)) {
    const remaining = ctx.retainer.minus(retainerApplied);
    await ctx.updateRetainer(tx, remaining);
    await logEvent(tx, {
      event: BillingEvent.RETAINER_APPLY,
      actor: opts.actor,
      clientId: ctx.auditClientId,
      groupId: ctx.auditGroupId,
      invoiceId: invoice.id,
      payload: { applied: Number(retainerApplied), remaining: Number(remaining) },
    });
  }

  // 10. Advance schedule cursor
  const nextDue = ctx.nextInvoiceDueAt
    ? advanceUntilFuture(ctx.nextInvoiceDueAt, now, ctx.cadenceOpts)
    : nextCadenceDate(now, ctx.cadenceOpts);
  await ctx.updateNextInvoiceDueAt(tx, nextDue);

  // 11. Audit
  await logEvent(tx, {
    event: status === "APPROVED" ? BillingEvent.INVOICE_APPROVED : BillingEvent.INVOICE_DRAFT,
    actor: opts.actor,
    clientId: ctx.auditClientId,
    groupId: ctx.auditGroupId,
    invoiceId: invoice.id,
    payload: {
      source: opts.source,
      total: Number(total),
      lineCount: lineItems.length,
      retainerApplied: Number(retainerApplied),
      memberCount: billable.kind === "group" ? billable.members.length : undefined,
    },
  });

  return {
    status: "created",
    invoiceId: invoice.id,
    invoiceNumber,
    total: Number(total),
  };
}

/**
 * Backwards-compat wrapper for callers that pass a clientId. New callers
 * should construct a Billable and call generateInvoiceForBillable directly.
 */
export async function generateInvoiceForClient(
  tx: Tx,
  clientId: string,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const client = await tx.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error(`Client ${clientId} not found`);
  return generateInvoiceForBillable(tx, { kind: "client", client }, opts);
}

export interface GenerateAllResult {
  total: number;
  created: number;
  skipped: { paused: number; no_work: number; not_due: number; lock: number };
  invoices: { billableId: string; invoiceId: string; invoiceNumber: string; total: number }[];
  errors: { billableId: string; message: string }[];
}

/**
 * Iterate every billable (solo clients without a group + active groups) and
 * generate invoices for those who are due. Each billable gets its own
 * transaction so a single failure doesn't roll back the whole run.
 */
export async function generateForAllDueBillables(
  opts: GenerateOpts,
): Promise<GenerateAllResult> {
  const result: GenerateAllResult = {
    total: 0,
    created: 0,
    skipped: { paused: 0, no_work: 0, not_due: 0, lock: 0 },
    invoices: [],
    errors: [],
  };

  // Solo clients (not in a group).
  const soloClients = await prisma.client.findMany({
    where: { status: "ACTIVE", billingGroupId: null },
  });

  // Active groups + their members in one query.
  const groups = await prisma.billingGroup.findMany({
    where: { status: "ACTIVE" },
    include: { members: { where: { status: "ACTIVE" } } },
  });

  result.total = soloClients.length + groups.length;

  const billables: Billable[] = [
    ...soloClients.map((client: Client): Billable => ({ kind: "client", client })),
    ...groups.map(
      (g: BillingGroup & { members: Client[] }): Billable => ({
        kind: "group",
        group: g,
        members: g.members,
      }),
    ),
  ];

  for (const b of billables) {
    const billableId = b.kind === "client" ? b.client.id : b.group.id;
    try {
      const r = await prisma.$transaction((tx) =>
        generateInvoiceForBillable(tx as Tx, b, opts),
      );
      if (r.status === "created" && r.invoiceId && r.invoiceNumber && r.total !== undefined) {
        result.created++;
        result.invoices.push({
          billableId,
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
        billableId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Backwards-compat alias. Existing callers (cron, manual generate route)
 * keep working with the old name.
 */
export const generateForAllDueClients = generateForAllDueBillables;
