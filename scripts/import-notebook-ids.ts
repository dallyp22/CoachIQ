/**
 * Import notebook IDs from backfill_manifest.json into PostgreSQL
 *
 * Run: npx tsx scripts/import-notebook-ids.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  const manifestPath = join(process.cwd(), "backfill_transcripts", "backfill_manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const clients = manifest.clients as Record<
    string,
    { name: string; notebook_id?: string; drive_folder_id?: string }
  >;

  let updated = 0;

  for (const [email, data] of Object.entries(clients)) {
    if (!data.notebook_id) continue;

    const result = await prisma.client.updateMany({
      where: { email: email.toLowerCase() },
      data: { notebookId: data.notebook_id },
    });

    if (result.count > 0) {
      console.log(`  ${data.name}: ${data.notebook_id}`);
      updated++;
    }
  }

  const withNotebook = await prisma.client.count({
    where: { notebookId: { not: null } },
  });

  console.log(`\nUpdated: ${updated} clients with notebook IDs`);
  console.log(`Total with notebook IDs: ${withNotebook}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
