/**
 * Void an invoice and restore its time entries to UNBILLED.
 *
 *   npx tsx scripts/void-invoice.ts <invoice-id>           # dry run
 *   npx tsx scripts/void-invoice.ts <invoice-id> --apply
 *
 * Refuses to void PAID invoices.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const id = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!id) {
    console.error("usage: tsx scripts/void-invoice.ts <invoice-id> [--apply]");
    process.exit(1);
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { client: true, _count: { select: { timeEntries: true } } },
  });
  if (!invoice) throw new Error(`Invoice ${id} not found`);
  if (invoice.status === "PAID") throw new Error("Refusing to void a PAID invoice");

  console.log(`${invoice.invoiceNumber} | ${invoice.status} | $${invoice.total} | ${invoice._count.timeEntries} entries | ${invoice.client?.name ?? "(group)"}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to void.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.timeEntry.updateMany({
      where: { invoiceId: id },
      data: { status: "UNBILLED", invoiceId: null },
    });
    await tx.invoice.update({
      where: { id },
      data: { status: "VOID" },
    });
    await tx.billingAuditLog.create({
      data: {
        event: "INVOICE_VOID",
        clientId: invoice.clientId,
        invoiceId: id,
        payload: { reason: "manual cleanup post Stripe-account migration" },
      },
    });
  });
  console.log(`Voided ${invoice.invoiceNumber}, restored ${invoice._count.timeEntries} entries to UNBILLED.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
