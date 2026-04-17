import type { Decimal } from "@prisma/client/runtime/client";
import type { Client, Invoice } from "@/generated/prisma/client";

export interface InvoiceSnapshot {
  snapshotClientName: string;
  snapshotBillingEmail: string;
  snapshotBillingCcEmails: string[];
  snapshotHourlyRate: Decimal;
}

/**
 * Capture a snapshot of the client's current billing-relevant fields.
 * Resolves displayName ?? name and billingContactEmail ?? email.
 *
 * Snapshots are taken once at DRAFT creation and frozen until "Refresh from
 * client" is explicitly clicked. This prevents post-hoc client edits from
 * silently mutating in-flight or sent invoices.
 */
export function snapshotClient(client: Client): InvoiceSnapshot {
  return {
    snapshotClientName: client.displayName ?? client.name,
    snapshotBillingEmail: client.billingContactEmail ?? client.email,
    snapshotBillingCcEmails: client.secondaryEmails ?? [],
    snapshotHourlyRate: client.hourlyRate,
  };
}

/**
 * Compare an invoice's snapshot fields against the client's current values.
 * Returns the list of human-readable field labels that have drifted.
 *
 * Used by the snapshot-banner UI to render the Amber-100 nudge ONLY when
 * drift is detected (per the design review decision — banner stays sharp,
 * doesn't become wallpaper).
 */
export function detectDrift(invoice: Invoice, client: Client): string[] {
  const drifted: string[] = [];
  const current = snapshotClient(client);

  if (
    invoice.snapshotClientName !== null &&
    invoice.snapshotClientName !== current.snapshotClientName
  ) {
    drifted.push("display name");
  }
  if (
    invoice.snapshotBillingEmail !== null &&
    invoice.snapshotBillingEmail !== current.snapshotBillingEmail
  ) {
    drifted.push("billing contact email");
  }
  if (
    invoice.snapshotBillingCcEmails &&
    !arraysEqual(invoice.snapshotBillingCcEmails, current.snapshotBillingCcEmails)
  ) {
    drifted.push("CC emails");
  }
  if (
    invoice.snapshotHourlyRate !== null &&
    !invoice.snapshotHourlyRate.equals(current.snapshotHourlyRate)
  ) {
    drifted.push("hourly rate");
  }

  return drifted;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  return aSorted.every((v, i) => v === bSorted[i]);
}
