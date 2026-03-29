/**
 * Import local transcript files into PostgreSQL
 *
 * Reads backfill_transcripts/{ClientName}/session_*.txt files,
 * matches to existing sessions by fathomRecordingId (from filename),
 * creates Transcript records.
 *
 * Run: npx tsx scripts/import-transcripts.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  const baseDir = join(process.cwd(), "backfill_transcripts");
  const clientDirs = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${clientDirs.length} client folders`);

  let created = 0;
  let matched = 0;
  let noSession = 0;
  let alreadyExists = 0;

  for (const clientDir of clientDirs) {
    const dirPath = join(baseDir, clientDir);
    const files = readdirSync(dirPath)
      .filter((f) => f.startsWith("session_") && f.endsWith(".txt"))
      .sort();

    for (const file of files) {
      // Extract recording ID from filename: session_01_2025-02-07_46233720.txt
      const match = file.match(/session_\d+_[\d-]+_(\d+)\.txt/);
      if (!match) continue;

      const recordingId = match[1];

      // Find matching session
      const session = await prisma.session.findUnique({
        where: { fathomRecordingId: recordingId },
        include: { transcript: true },
      });

      if (!session) {
        noSession++;
        continue;
      }

      matched++;

      // Skip if transcript already exists
      if (session.transcript) {
        alreadyExists++;
        continue;
      }

      // Read transcript file
      const fullText = readFileSync(join(dirPath, file), "utf-8");
      const wordCount = fullText.split(/\s+/).length;

      await prisma.transcript.create({
        data: {
          sessionId: session.id,
          clientId: session.clientId,
          fullText,
          wordCount,
        },
      });

      created++;
    }
  }

  const totalTranscripts = await prisma.transcript.count();

  console.log(`\nImport complete:`);
  console.log(`  Matched to sessions: ${matched}`);
  console.log(`  Transcripts created: ${created}`);
  console.log(`  Already existed: ${alreadyExists}`);
  console.log(`  No matching session: ${noSession}`);
  console.log(`  Total transcripts in DB: ${totalTranscripts}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
