/**
 * Blanket-set every client's hourly rate, then propagate the change through
 * open time entries and DRAFT invoices so the next round of invoices reflects
 * the new rate consistently.
 *
 *   npx tsx scripts/set-rate.ts                    # dry run, default rate 500
 *   npx tsx scripts/set-rate.ts 450                # dry run at $450
 *   npx tsx scripts/set-rate.ts 500 --apply        # commit at $500
 *
 * Layers updated (all in one transaction):
 *   1. Client.hourlyRate                                                → newRate
 *   2. TimeEntry (status in [UNBILLED, STAGED]): hourlyRate, amount     → recomputed
 *   3. Invoice (status in [DRAFT, PENDING_REVIEW, APPROVED]):
 *        - lineItems[].rate / .amount for entries linked to a timeEntryId
 *        - subtotal = sum(lineItems.amount)
 *        - total    = subtotal               (matches generate.ts semantics)
 *        - snapshotHourlyRate                → newRate
 *      Every touched invoice gets a BillingAuditLog row (event=MANUAL_EDIT).
 *
 * SENT / PAID / OVERDUE / VOID invoices are left alone — those snapshots
 * are immutable for audit reasons.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { Decimal } from "@prisma/client/runtime/client";
import { PrismaPg } from "@prisma/adapter-pg";

interface LineItem {
  date: string;
  description: string;
  hours: number;
  rate: number;
  amount: number;
  timeEntryId?: string;
}

const REWRITABLE_INVOICE_STATUSES: ("DRAFT" | "PENDING_REVIEW" | "APPROVED")[] = [
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
];

function makePrisma() {
  const adapter = new PrismaPg({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const newRate = positional[0] ? Number(positional[0]) : 500;

  if (!Number.isFinite(newRate) || newRate <= 0) {
    console.error(`Invalid rate: ${positional[0]}`);
    process.exit(2);
  }

  const prisma = makePrisma();
  try {
    // ─── Survey ─────────────────────────────────────────────────────
    const [clientCount, openEntries, invoices] = await Promise.all([
      prisma.client.count(),
      prisma.timeEntry.findMany({
        where: { status: { in: ["UNBILLED", "STAGED"] } },
        select: {
          id: true,
          billableHours: true,
          hourlyRate: true,
          amount: true,
          status: true,
        },
      }),
      prisma.invoice.findMany({
        where: { status: { in: REWRITABLE_INVOICE_STATUSES } },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          lineItems: true,
          subtotal: true,
          total: true,
          snapshotHourlyRate: true,
          clientId: true,
        },
      }),
    ]);

    // Project entry deltas
    const entryDeltas = openEntries.map((e) => {
      const newAmount = round2(Number(e.billableHours) * newRate);
      return {
        id: e.id,
        oldRate: Number(e.hourlyRate),
        oldAmount: Number(e.amount),
        newRate,
        newAmount,
        changed:
          Number(e.hourlyRate) !== newRate || Number(e.amount) !== newAmount,
      };
    });
    const entriesChanging = entryDeltas.filter((d) => d.changed);

    // Project invoice deltas
    const invoiceDeltas = invoices.map((inv) => {
      const lines = (inv.lineItems as unknown as LineItem[]) ?? [];
      const newLines = lines.map((li) => {
        if (!li.timeEntryId) return li; // retainer / non-session line, untouched
        const newAmt = round2(li.hours * newRate);
        return { ...li, rate: newRate, amount: newAmt };
      });
      const newSubtotal = round2(
        newLines.reduce((sum, li) => sum + (li.amount ?? 0), 0)
      );
      const newTotal = newSubtotal; // mirrors generate.ts (tax stays 0)
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientId: inv.clientId,
        oldSubtotal: Number(inv.subtotal),
        newSubtotal,
        oldTotal: Number(inv.total),
        newTotal,
        oldSnapshotRate:
          inv.snapshotHourlyRate === null
            ? null
            : Number(inv.snapshotHourlyRate),
        newLines,
        changed:
          Number(inv.subtotal) !== newSubtotal ||
          Number(inv.total) !== newTotal ||
          (inv.snapshotHourlyRate === null
            ? true
            : Number(inv.snapshotHourlyRate) !== newRate),
      };
    });
    const invoicesChanging = invoiceDeltas.filter((d) => d.changed);

    // ─── Plan output ────────────────────────────────────────────────
    const totalOldOpen = entryDeltas.reduce((s, d) => s + d.oldAmount, 0);
    const totalNewOpen = entryDeltas.reduce((s, d) => s + d.newAmount, 0);
    const totalOldDrafts = invoiceDeltas.reduce((s, d) => s + d.oldTotal, 0);
    const totalNewDrafts = invoiceDeltas.reduce((s, d) => s + d.newTotal, 0);

    console.log(`Plan — set hourly rate to $${newRate.toFixed(2)}\n`);
    console.log(`  clients              ${clientCount} rows  →  hourlyRate = ${newRate}`);
    console.log(
      `  open time entries    ${entriesChanging.length}/${openEntries.length} rows change  (UNBILLED + STAGED)`
    );
    console.log(
      `    open $$           $${totalOldOpen.toFixed(2)}  →  $${totalNewOpen.toFixed(2)}  (Δ $${(totalNewOpen - totalOldOpen).toFixed(2)})`
    );
    console.log(
      `  draft invoices       ${invoicesChanging.length}/${invoices.length} rows change`
    );
    console.log(
      `    draft total $$    $${totalOldDrafts.toFixed(2)}  →  $${totalNewDrafts.toFixed(2)}  (Δ $${(totalNewDrafts - totalOldDrafts).toFixed(2)})\n`
    );

    if (invoicesChanging.length > 0) {
      console.log("  Invoices changing (showing up to 8):");
      for (const inv of invoicesChanging.slice(0, 8)) {
        console.log(
          `    ${inv.invoiceNumber.padEnd(14)}  $${inv.oldTotal.toFixed(2).padStart(9)}  →  $${inv.newTotal.toFixed(2).padStart(9)}`
        );
      }
      if (invoicesChanging.length > 8) {
        console.log(`    … and ${invoicesChanging.length - 8} more.`);
      }
      console.log();
    }

    if (!apply) {
      console.log("(dry run — pass --apply to commit)");
      return;
    }

    // ─── Apply ──────────────────────────────────────────────────────
    // ~466 row updates (380 time entries + 86 invoices). Default 5s tx
    // timeout isn't enough; bump to 90s with a 30s acquire wait.
    await prisma.$transaction(
      async (tx) => {
      // 1. Clients
      await tx.client.updateMany({
        data: { hourlyRate: new Decimal(newRate) },
      });

      // 2. Open time entries — must compute amount per row, can't be a single
      //    updateMany since amount depends on per-row billableHours.
      for (const d of entriesChanging) {
        await tx.timeEntry.update({
          where: { id: d.id },
          data: {
            hourlyRate: new Decimal(d.newRate),
            amount: new Decimal(d.newAmount),
          },
        });
      }

      // 3. Invoices — rewrite lineItems + subtotal/total + snapshotHourlyRate.
      for (const d of invoicesChanging) {
        await tx.invoice.update({
          where: { id: d.id },
          data: {
            // Cast through unknown — the Json column accepts arbitrary JSON.
            lineItems: d.newLines as unknown as object,
            subtotal: new Decimal(d.newSubtotal),
            total: new Decimal(d.newTotal),
            snapshotHourlyRate: new Decimal(newRate),
          },
        });
        await tx.billingAuditLog.create({
          data: {
            event: "MANUAL_EDIT",
            actor: "scripts/set-rate.ts",
            clientId: d.clientId,
            invoiceId: d.id,
            payload: {
              kind: "blanket_rate_change",
              newRate,
              oldSnapshotRate: d.oldSnapshotRate,
              oldTotal: d.oldTotal,
              newTotal: d.newTotal,
            },
          },
        });
      }
    },
      { timeout: 90_000, maxWait: 30_000 }
    );

    console.log("\nApplied.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
