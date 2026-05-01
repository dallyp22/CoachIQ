import type { Decimal } from "@prisma/client/runtime/client";
import type { BillingGroup, Client, Invoice } from "@/generated/prisma/client";

export interface InvoiceSnapshot {
  snapshotClientName: string;
  snapshotBillingEmail: string;
  snapshotBillingCcEmails: string[];
  // For group invoices with no group-level rate override and mixed-rate
  // members, this is null (rate is per-line, not per-invoice).
  snapshotHourlyRate: Decimal | null;
}

export type Billable =
  | { kind: "client"; client: Client }
  | { kind: "group"; group: BillingGroup; members: Client[] };

/**
 * Capture a snapshot of a billable's billing-relevant fields.
 *
 * Snapshots are taken once at DRAFT creation and frozen until "Refresh from
 * billable" is explicitly clicked. This prevents post-hoc edits from silently
 * mutating in-flight or sent invoices.
 */
export function snapshotBillable(b: Billable): InvoiceSnapshot {
  if (b.kind === "client") {
    return {
      snapshotClientName: b.client.displayName ?? b.client.name,
      snapshotBillingEmail: b.client.billingContactEmail ?? b.client.email,
      snapshotBillingCcEmails: b.client.secondaryEmails ?? [],
      snapshotHourlyRate: b.client.hourlyRate,
    };
  }
  return {
    snapshotClientName: b.group.displayName ?? b.group.name,
    snapshotBillingEmail: b.group.billingContactEmail,
    snapshotBillingCcEmails: b.group.ccEmails ?? [],
    // Null if group has no rate override (rate is per-line per-member);
    // populated if group-level override is set.
    snapshotHourlyRate: b.group.hourlyRate,
  };
}

/**
 * Back-compat shim — call sites that still pass a raw Client get the same
 * behavior they had before the Billable refactor. New code should call
 * snapshotBillable directly.
 */
export function snapshotClient(client: Client): InvoiceSnapshot {
  return snapshotBillable({ kind: "client", client });
}

/**
 * Compare an invoice's snapshot fields against the billable's current values.
 * Returns the list of human-readable field labels that have drifted.
 */
export function detectDrift(invoice: Invoice, billable: Client | Billable): string[] {
  const b: Billable =
    "kind" in billable ? billable : { kind: "client", client: billable };
  const drifted: string[] = [];
  const current = snapshotBillable(b);

  if (
    invoice.snapshotClientName !== null &&
    invoice.snapshotClientName !== current.snapshotClientName
  ) {
    drifted.push(b.kind === "group" ? "group name" : "display name");
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
    current.snapshotHourlyRate !== null &&
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
