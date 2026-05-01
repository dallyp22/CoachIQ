/**
 * Clear stripeCustomerId on all clients. Used after switching Stripe accounts —
 * cached customer IDs point at customers that don't exist in the new account
 * and cause "No such customer" errors when sending invoices.
 *
 *   npx tsx scripts/clear-stale-stripe-customers.ts            # dry run
 *   npx tsx scripts/clear-stale-stripe-customers.ts --apply    # commit
 *
 * The send route at src/app/api/invoices/[id]/send/route.ts will create a
 * new customer in the correct account on next send if stripeCustomerId is null.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const apply = process.argv.includes("--apply");

  const adapter = new PrismaPg({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  const stale = await prisma.client.findMany({
    where: { stripeCustomerId: { not: null } },
    select: { id: true, name: true, email: true, stripeCustomerId: true },
  });

  console.log(`${stale.length} client(s) with cached stripeCustomerId:`);
  for (const c of stale) {
    console.log(`  ${c.name} (${c.email}) → ${c.stripeCustomerId}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to clear.");
    return;
  }

  const r = await prisma.client.updateMany({
    where: { stripeCustomerId: { not: null } },
    data: { stripeCustomerId: null },
  });
  console.log(`\nCleared ${r.count} record(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
