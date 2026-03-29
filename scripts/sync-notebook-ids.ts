/**
 * Sync notebook IDs from NotebookLM into PostgreSQL
 * Reads /tmp/coachiq-notebooks.json (output from notebooklm CLI)
 *
 * Run: npx tsx scripts/sync-notebook-ids.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "fs";

interface Notebook {
  id: string;
  title: string;
}

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  const notebooks: Notebook[] = JSON.parse(
    readFileSync("/tmp/coachiq-notebooks.json", "utf-8")
  );
  console.log(`Loaded ${notebooks.length} CoachIQ notebooks`);

  // Load all clients for matching
  const clients = await prisma.client.findMany();
  console.log(`Loaded ${clients.length} clients`);

  let linked = 0;
  let alreadyLinked = 0;
  let noMatch = 0;

  for (const nb of notebooks) {
    // Extract client name from "CoachIQ | Client Name"
    const clientName = nb.title.replace("CoachIQ | ", "").trim();

    // Find matching client by name (case-insensitive, fuzzy)
    const match = clients.find((c) => {
      const cName = c.name.toLowerCase().trim();
      const nbName = clientName.toLowerCase().trim();
      // Exact match
      if (cName === nbName) return true;
      // Name contains (handles "Pfeiffer, Alex R" vs "Alex Pfeiffer")
      const nbParts = nbName.split(/[\s,]+/).filter(p => p.length > 2);
      return nbParts.every(part => cName.includes(part));
    });

    if (!match) {
      noMatch++;
      continue;
    }

    if (match.notebookId === nb.id) {
      alreadyLinked++;
      continue;
    }

    await prisma.client.update({
      where: { id: match.id },
      data: { notebookId: nb.id },
    });
    linked++;
    console.log(`  ${match.name} → ${nb.id}`);
  }

  const withNotebook = await prisma.client.count({
    where: { notebookId: { not: null } },
  });

  console.log(`\nSync complete:`);
  console.log(`  Newly linked: ${linked}`);
  console.log(`  Already linked: ${alreadyLinked}`);
  console.log(`  No match found: ${noMatch}`);
  console.log(`  Total with notebook: ${withNotebook}/${clients.length}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
