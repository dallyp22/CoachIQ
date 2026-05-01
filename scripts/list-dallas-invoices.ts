import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });
  const invoices = await prisma.invoice.findMany({
    where: { client: { email: "dallas.polivka@dpaauctions.com" } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { timeEntries: true } } },
  });
  for (const i of invoices) {
    console.log(`${i.invoiceNumber} | ${i.status.padEnd(8)} | $${i.total} | ${i._count.timeEntries} entries | id=${i.id}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
