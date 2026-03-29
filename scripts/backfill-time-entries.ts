/**
 * Backfill TimeEntry records for all existing sessions
 *
 * For each session without a TimeEntry, creates one using:
 *   billableHours = ceiling(durationMinutes / 15) * 0.25
 *   amount = billableHours * client.hourlyRate
 *
 * Run: npx tsx scripts/backfill-time-entries.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
// Prisma accepts number | string for Decimal fields

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Find sessions without time entries
  const sessions = await prisma.session.findMany({
    where: { timeEntry: null },
    include: { client: { select: { hourlyRate: true } } },
  });

  console.log(`Found ${sessions.length} sessions without time entries`);

  let created = 0;

  for (const session of sessions) {
    const billableHours = Math.ceil(session.durationMinutes / 15) * 0.25;
    const hourlyRate = Number(session.client.hourlyRate);
    const amount = billableHours * hourlyRate;

    await prisma.timeEntry.create({
      data: {
        sessionId: session.id,
        clientId: session.clientId,
        date: session.date,
        description: session.title,
        billableHours,
        hourlyRate,
        amount,
        isManual: false,
        status: "UNBILLED",
      },
    });

    created++;
  }

  const totalEntries = await prisma.timeEntry.count();
  const totalUnbilled = await prisma.timeEntry.count({ where: { status: "UNBILLED" } });

  console.log(`\nBackfill complete:`);
  console.log(`  Created: ${created} time entries`);
  console.log(`  Total in DB: ${totalEntries}`);
  console.log(`  Unbilled: ${totalUnbilled}`);

  // Show total unbilled amount
  const unbilledEntries = await prisma.timeEntry.findMany({
    where: { status: "UNBILLED" },
  });
  const totalAmount = unbilledEntries.reduce((sum, e) => sum + Number(e.amount), 0);
  console.log(`  Total unbilled amount: $${totalAmount.toLocaleString()}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
