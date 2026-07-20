/**
 * Billing clean-slate — one-shot script to start CoachIQ billing fresh.
 *
 * Run this when you want the app to forget all prior billing state and
 * begin invoicing from "now" forward. Historical billing tracked elsewhere
 * (spreadsheets, prior system, etc.) is unaffected.
 *
 * What it does (in one transaction):
 *   1. Delete all InvoiceAdjustment rows
 *   2. Delete all Invoice rows
 *   3. Mark every TimeEntry as WRITTEN_OFF (so the next cron run starts from
 *      a blank invoicing slate — any new sessions captured AFTER this script
 *      runs will be UNBILLED and billable normally)
 *   4. Clear nextInvoiceDueAt on every client (so the cadence cursor
 *      recomputes from "now" on the next cron firing)
 *   5. Zero out all retainer balances (pass --keep-retainers to skip)
 *   6. Drop a RESET event in billing_audit_logs with counts
 *
 * Stripe customer IDs are preserved (payment methods stay on file).
 *
 * Usage:
 *   npx tsx scripts/billing-clean-slate.ts            # wipes everything, zeros retainers
 *   npx tsx scripts/billing-clean-slate.ts --dry-run  # shows what would change, makes no writes
 *   npx tsx scripts/billing-clean-slate.ts --keep-retainers
 */

import { prisma } from "../src/lib/db";
import { Decimal } from "@prisma/client/runtime/client";

const DRY_RUN = process.argv.includes("--dry-run");
const KEEP_RETAINERS = process.argv.includes("--keep-retainers");

async function main() {
  const counts = {
    invoices: await prisma.invoice.count(),
    adjustments: await prisma.invoiceAdjustment.count(),
    timeEntries: await prisma.timeEntry.count(),
    clientsWithDueAt: await prisma.client.count({
      where: { nextInvoiceDueAt: { not: null } },
    }),
    clientsWithRetainer: await prisma.client.count({
      where: { retainer: { gt: 0 } },
    }),
  };

  console.log("\n━━━ Billing Clean Slate ━━━");
  console.log(`  Invoices to delete:          ${counts.invoices}`);
  console.log(`  Adjustments to delete:       ${counts.adjustments}`);
  console.log(`  Time entries → WRITTEN_OFF:  ${counts.timeEntries}`);
  console.log(`  Clients w/ nextInvoiceDueAt: ${counts.clientsWithDueAt}`);
  console.log(
    `  Clients w/ retainer:         ${counts.clientsWithRetainer} ${KEEP_RETAINERS ? "(KEEPING)" : "(zeroing)"}`,
  );
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log("");

  if (DRY_RUN) {
    console.log("Dry run complete. No changes written.");
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    // 1 + 2. Wipe invoices and adjustments
    await tx.invoiceAdjustment.deleteMany({});
    await tx.invoice.deleteMany({});

    // 3. Close the books on every existing time entry. Nothing before this
    //    moment will ever appear on a future invoice.
    await tx.timeEntry.updateMany({
      data: { status: "WRITTEN_OFF", invoiceId: null },
    });

    // 4. Clear cadence cursor — next cron fire recomputes from "now" per client
    const clientUpdate: { nextInvoiceDueAt: null; retainer?: Decimal } = {
      nextInvoiceDueAt: null,
    };
    if (!KEEP_RETAINERS) {
      clientUpdate.retainer = new Decimal(0);
    }
    const clientUpd = await tx.client.updateMany({ data: clientUpdate });

    // 5. Audit log
    await tx.billingAuditLog.create({
      data: {
        event: "RESET",
        actor: null, // script run, not a user action
        payload: {
          ...counts,
          keepRetainers: KEEP_RETAINERS,
          scriptedAt: new Date().toISOString(),
          source: "billing-clean-slate.ts",
        },
      },
    });

    return { clientsUpdated: clientUpd.count };
  });

  console.log("✓ Clean slate applied");
  console.log(`  Clients updated: ${result.clientsUpdated}`);
  console.log("");
  console.log("Next cron run (13:00 UTC / 7am CT daily) will evaluate each active client's");
  console.log("cadence from this moment forward. Sessions captured from now on become UNBILLED");
  console.log("and are eligible for the next generated invoice.");
}

main()
  .catch((err) => {
    console.error("ERROR:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
