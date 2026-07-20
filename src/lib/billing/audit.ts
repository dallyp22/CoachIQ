import { Prisma } from "@/generated/prisma/client";

type Tx = Omit<Prisma.TransactionClient, "$transaction" | "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

/**
 * Type-safe set of audit event names. State transitions + admin actions only,
 * per the engineering review decision (avoids noisy per-keystroke logging).
 */
export const BillingEvent = {
  // Invoice lifecycle
  INVOICE_DRAFT: "INVOICE_DRAFT",
  INVOICE_APPROVED: "INVOICE_APPROVED",
  INVOICE_SENT: "INVOICE_SENT",
  INVOICE_PAID: "INVOICE_PAID",
  INVOICE_VOID: "INVOICE_VOID",
  INVOICE_REFRESHED: "INVOICE_REFRESHED",
  INVOICE_ADJUSTED: "INVOICE_ADJUSTED",
  // Generation
  CRON_GEN: "CRON_GEN",
  MANUAL_GEN: "MANUAL_GEN",
  // Client billing edits
  CADENCE_CHANGE: "CADENCE_CHANGE",
  MANUAL_EDIT: "MANUAL_EDIT",
  // Retainer
  RETAINER_ADD: "RETAINER_ADD",
  RETAINER_APPLY: "RETAINER_APPLY",
  // Admin
  RESET: "RESET",
  // Billing groups
  GROUP_CREATED: "GROUP_CREATED",
  GROUP_UPDATED: "GROUP_UPDATED",
  GROUP_DELETED: "GROUP_DELETED",
  GROUP_MEMBER_ADDED: "GROUP_MEMBER_ADDED",
  GROUP_MEMBER_REMOVED: "GROUP_MEMBER_REMOVED",
  // Pipeline. This table has no prospectId column, so these carry it in the
  // payload — they are the human-readable "who did what" trail, not the data
  // the reports query. Stage history the reports read lives in
  // ProspectStageChange, as typed columns (PRD §13.7).
  PROSPECT_CREATED: "PROSPECT_CREATED",
  PROSPECT_UPDATED: "PROSPECT_UPDATED",
  PROSPECT_DELETED: "PROSPECT_DELETED",
  PROSPECT_STAGE_CHANGED: "PROSPECT_STAGE_CHANGED",
  PROSPECT_CONVERTED: "PROSPECT_CONVERTED",
  PIPELINE_STAGE_UPDATED: "PIPELINE_STAGE_UPDATED",
} as const;

export type BillingEventName = (typeof BillingEvent)[keyof typeof BillingEvent];

export interface AuditEntry {
  event: BillingEventName;
  actor?: string | null;
  clientId?: string | null;
  groupId?: string | null;
  invoiceId?: string | null;
  payload?: unknown;
}

/**
 * Insert a row into billing_audit_logs. MUST be called inside the same
 * transaction as the state change it audits, so a rollback wipes both.
 */
export async function logEvent(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.billingAuditLog.create({
    data: {
      event: entry.event,
      actor: entry.actor ?? null,
      clientId: entry.clientId ?? null,
      groupId: entry.groupId ?? null,
      invoiceId: entry.invoiceId ?? null,
      payload: (entry.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}
