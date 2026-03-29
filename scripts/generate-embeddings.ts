/**
 * Generate OpenAI embeddings for all transcripts missing embeddings
 *
 * Uses text-embedding-3-small (1536 dimensions).
 * Truncates transcript to ~8000 tokens (~32000 chars) to stay within limits.
 * Stores embeddings directly in pgvector column via raw SQL.
 *
 * Run: npx tsx scripts/generate-embeddings.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const OPENAI_API_KEY = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY || "";
const BATCH_SIZE = 5; // Smaller batches for long transcripts
const MAX_CHARS = 20000; // ~5000 tokens, safe under 8192 limit

async function main() {
  if (!OPENAI_API_KEY) {
    console.error("No OpenAI API key found. Set OPEN_AI_API or OPENAI_API_KEY in .env");
    process.exit(1);
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Find transcripts without embeddings
  const transcripts = await prisma.$queryRawUnsafe<
    Array<{ id: string; fullText: string }>
  >(`
    SELECT id, "fullText"
    FROM transcripts
    WHERE embedding IS NULL
    ORDER BY "createdAt" ASC
  `);

  console.log(`Found ${transcripts.length} transcripts needing embeddings`);

  let processed = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < transcripts.length; i += BATCH_SIZE) {
    const batch = transcripts.slice(i, i + BATCH_SIZE);

    // Truncate texts for embedding
    const texts = batch.map((t) =>
      t.fullText.length > MAX_CHARS ? t.fullText.slice(0, MAX_CHARS) : t.fullText
    );

    try {
      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: texts,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`OpenAI API error ${resp.status}: ${errText.slice(0, 200)}`);
        errors += batch.length;
        continue;
      }

      const data = await resp.json();
      const embeddings: Array<{ embedding: number[]; index: number }> = data.data;

      // Store each embedding via raw SQL
      for (const emb of embeddings) {
        const transcript = batch[emb.index];
        const vectorStr = `[${emb.embedding.join(",")}]`;

        await prisma.$queryRawUnsafe(
          `UPDATE transcripts SET embedding = $1::vector, "embeddingModel" = $2 WHERE id = $3::uuid`,
          vectorStr,
          "text-embedding-3-small",
          transcript.id
        );
      }

      processed += batch.length;
      console.log(`  ${processed}/${transcripts.length} embedded`);
    } catch (err) {
      console.error(`Batch error:`, err);
      errors += batch.length;
    }

    // Rate limit: ~3000 RPM for embeddings, but be gentle
    if (i + BATCH_SIZE < transcripts.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\nEmbedding complete:`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Errors: ${errors}`);

  // Verify
  const withEmbeddings = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) as count FROM transcripts WHERE embedding IS NOT NULL`
  );
  console.log(`  Transcripts with embeddings: ${withEmbeddings[0].count}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
