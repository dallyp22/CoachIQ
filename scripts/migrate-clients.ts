/**
 * Migrate 93 clients from client_registry.json → Neon PostgreSQL
 *
 * Run: npx tsx scripts/migrate-clients.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "fs";
import { join } from "path";

interface RegistryEntry {
  name: string;
  notebook_id: string | null;
  drive_folder_id: string | null;
}

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Read client_registry.json
  const registryPath = join(process.cwd(), "client_registry.json");
  const registry: Record<string, RegistryEntry> = JSON.parse(
    readFileSync(registryPath, "utf-8")
  );

  const entries = Object.entries(registry);
  console.log(`Found ${entries.length} clients in client_registry.json`);

  let created = 0;
  let skipped = 0;

  for (const [email, data] of entries) {
    // Check if client already exists
    const existing = await prisma.client.findUnique({ where: { email } });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.client.create({
      data: {
        name: data.name,
        email: email.toLowerCase(),
        notebookId: data.notebook_id,
        driveFolderId: data.drive_folder_id,
        hourlyRate: 300,
        status: "ACTIVE",
      },
    });
    created++;
  }

  console.log(`Migration complete: ${created} created, ${skipped} skipped (already exist)`);

  // Also create the CoachSettings singleton
  const settings = await prisma.coachSettings.findFirst();
  if (!settings) {
    await prisma.coachSettings.create({
      data: {
        coachName: "Todd Zimbelman",
        coachEmail: "todd@growwithcocreate.com",
        businessName: "Co-Create Coaching",
        defaultHourlyRate: 300,
      },
    });
    console.log("Created CoachSettings record");
  }

  // Print summary
  const count = await prisma.client.count();
  console.log(`Total clients in database: ${count}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
