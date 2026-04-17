import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";
import { snapshotClient, detectDrift } from "@/lib/billing/snapshot";
import type { Client, Invoice } from "@/generated/prisma/client";

/**
 * Build a minimal Client object. Cast to Client because the full Prisma type has
 * many fields irrelevant to snapshot logic.
 */
function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: "client-1",
    name: "Sarah Chen (Legal)",
    displayName: null,
    email: "sarah@chen.com",
    secondaryEmails: [],
    phone: null,
    company: null,
    address: null,
    hourlyRate: new Decimal(300),
    billingCadence: "MONTHLY",
    customCadenceDays: null,
    billingContactName: null,
    billingContactEmail: null,
    billingPausedUntil: null,
    billingNotes: null,
    nextInvoiceDueAt: null,
    billingTimezone: null,
    retainer: new Decimal(0),
    meetingCadence: "BIWEEKLY",
    stripeCustomerId: null,
    notebookId: null,
    driveFolderId: null,
    allowsFathom: true,
    status: "ACTIVE",
    notes: null,
    tags: [],
    sessionCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Client;
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    clientId: "client-1",
    invoiceNumber: "CIQ-2026-0001",
    periodStart: new Date(),
    periodEnd: new Date(),
    lineItems: [],
    subtotal: new Decimal(0),
    tax: new Decimal(0),
    total: new Decimal(0),
    status: "DRAFT",
    stripeInvoiceId: null,
    stripePaymentUrl: null,
    sentAt: null,
    paidAt: null,
    notes: null,
    snapshotClientName: "Sarah Chen (Legal)",
    snapshotBillingEmail: "sarah@chen.com",
    snapshotBillingCcEmails: [],
    snapshotHourlyRate: new Decimal(300),
    parentInvoiceId: null,
    lastReminderSentAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Invoice;
}

describe("snapshotClient", () => {
  it("uses displayName when present", () => {
    const c = makeClient({ displayName: "Sarah Chen" });
    expect(snapshotClient(c).snapshotClientName).toBe("Sarah Chen");
  });

  it("falls back to name when displayName is null", () => {
    const c = makeClient({ displayName: null, name: "Sarah Chen (Legal)" });
    expect(snapshotClient(c).snapshotClientName).toBe("Sarah Chen (Legal)");
  });

  it("uses billingContactEmail when present", () => {
    const c = makeClient({ billingContactEmail: "ap@chen.com" });
    expect(snapshotClient(c).snapshotBillingEmail).toBe("ap@chen.com");
  });

  it("falls back to email when billingContactEmail is null", () => {
    const c = makeClient({ billingContactEmail: null, email: "sarah@chen.com" });
    expect(snapshotClient(c).snapshotBillingEmail).toBe("sarah@chen.com");
  });

  it("captures secondaryEmails as the snapshot CC list", () => {
    const c = makeClient({ secondaryEmails: ["ea@chen.com", "accounting@chen.com"] });
    expect(snapshotClient(c).snapshotBillingCcEmails).toEqual([
      "ea@chen.com",
      "accounting@chen.com",
    ]);
  });

  it("captures hourlyRate as Decimal", () => {
    const c = makeClient({ hourlyRate: new Decimal(450.5) });
    expect(snapshotClient(c).snapshotHourlyRate.equals(new Decimal(450.5))).toBe(true);
  });
});

describe("detectDrift", () => {
  it("returns empty array when invoice matches client", () => {
    const c = makeClient();
    const inv = makeInvoice();
    expect(detectDrift(inv, c)).toEqual([]);
  });

  it("detects display-name drift", () => {
    const c = makeClient({ displayName: "Sarah Chen" });
    const inv = makeInvoice({ snapshotClientName: "Old Name" });
    expect(detectDrift(inv, c)).toContain("display name");
  });

  it("detects billing-email drift", () => {
    const c = makeClient({ billingContactEmail: "new@chen.com" });
    const inv = makeInvoice({ snapshotBillingEmail: "old@chen.com" });
    expect(detectDrift(inv, c)).toContain("billing contact email");
  });

  it("detects CC-email drift when added", () => {
    const c = makeClient({ secondaryEmails: ["new-cc@chen.com"] });
    const inv = makeInvoice({ snapshotBillingCcEmails: [] });
    expect(detectDrift(inv, c)).toContain("CC emails");
  });

  it("detects CC-email drift when removed", () => {
    const c = makeClient({ secondaryEmails: [] });
    const inv = makeInvoice({ snapshotBillingCcEmails: ["was-here@chen.com"] });
    expect(detectDrift(inv, c)).toContain("CC emails");
  });

  it("treats CC-email arrays as order-independent (no false drift on reorder)", () => {
    const c = makeClient({ secondaryEmails: ["b@chen.com", "a@chen.com"] });
    const inv = makeInvoice({ snapshotBillingCcEmails: ["a@chen.com", "b@chen.com"] });
    expect(detectDrift(inv, c)).not.toContain("CC emails");
  });

  it("detects hourly-rate drift", () => {
    const c = makeClient({ hourlyRate: new Decimal(350) });
    const inv = makeInvoice({ snapshotHourlyRate: new Decimal(300) });
    expect(detectDrift(inv, c)).toContain("hourly rate");
  });

  it("ignores hourly-rate drift when both equal but different precision", () => {
    const c = makeClient({ hourlyRate: new Decimal("300.00") });
    const inv = makeInvoice({ snapshotHourlyRate: new Decimal("300") });
    expect(detectDrift(inv, c)).not.toContain("hourly rate");
  });

  it("returns ALL drifted fields, not just the first", () => {
    const c = makeClient({
      displayName: "New Name",
      billingContactEmail: "new@chen.com",
      hourlyRate: new Decimal(400),
    });
    const inv = makeInvoice({
      snapshotClientName: "Old Name",
      snapshotBillingEmail: "old@chen.com",
      snapshotHourlyRate: new Decimal(300),
    });
    const drift = detectDrift(inv, c);
    expect(drift).toContain("display name");
    expect(drift).toContain("billing contact email");
    expect(drift).toContain("hourly rate");
  });

  it("handles legacy invoices with NULL snapshot fields gracefully (no drift)", () => {
    const c = makeClient();
    const inv = makeInvoice({
      snapshotClientName: null,
      snapshotBillingEmail: null,
      snapshotHourlyRate: null,
    });
    // Null snapshots = pre-snapshot-era invoice; treat as "no drift to report"
    expect(detectDrift(inv, c)).toEqual([]);
  });

  it("handles legacy invoice with NULL snapshotClientName but populated email", () => {
    const c = makeClient({
      displayName: null,
      billingContactEmail: "different@chen.com",
    });
    const inv = makeInvoice({
      snapshotClientName: null,
      snapshotBillingEmail: "snapshotted@chen.com",
    });
    // Email drifted, name field is null so skipped
    const drift = detectDrift(inv, c);
    expect(drift).toContain("billing contact email");
    expect(drift).not.toContain("display name");
  });
});
