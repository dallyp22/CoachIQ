/**
 * One-shot: ensure a "Dallas Polivka" test client exists with the given email,
 * and seed a single $1 unbilled TimeEntry so a draft invoice can be generated.
 *
 *   npx tsx scripts/seed-test-invoice.ts
 *
 * Idempotent: re-running just adds another $1 entry.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { Decimal } from "@prisma/client/runtime/client";
import { PrismaPg } from "@prisma/adapter-pg";

const NAME = "Dallas Polivka";
const EMAIL = "dallas.polivka@dpaauctions.com";

async function main() {
  const adapter = new PrismaPg({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  const owner = await prisma.coach.findFirst({
    where: { role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!owner) throw new Error("No OWNER coach — run the multi-coach migration first.");

  let client = await prisma.client.findUnique({
    where: { coachId_email: { coachId: owner.id, email: EMAIL } },
  });
  if (!client) {
    client = await prisma.client.create({
      data: {
        coachId: owner.id,
        name: NAME,
        email: EMAIL,
        hourlyRate: new Decimal(100),
        status: "ACTIVE",
        allowsFathom: false,
        notes: "Test client for Stripe invoice flow.",
      },
    });
    console.log(`Created client ${client.id}`);
  } else {
    console.log(`Client exists: ${client.id}`);
  }

  const entry = await prisma.timeEntry.create({
    data: {
      clientId: client.id,
      date: new Date(),
      description: "Test entry — $1",
      billableHours: new Decimal(0.01),
      hourlyRate: new Decimal(100),
      amount: new Decimal(1),
      isManual: true,
      status: "UNBILLED",
    },
  });
  console.log(`Created time entry ${entry.id} ($1)`);

  console.log("\nNext: open the dashboard, find Dallas Polivka, click 'Generate Draft Invoice'.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
