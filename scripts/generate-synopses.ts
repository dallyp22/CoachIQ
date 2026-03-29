/**
 * Generate AI synopses for sessions that don't have one.
 * Uses OpenAI GPT-4o-mini via the transcript text.
 *
 * Run: npx tsx scripts/generate-synopses.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const OPENAI_API_KEY = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY || "";

async function main() {
  if (!OPENAI_API_KEY) {
    console.error("No OpenAI API key. Set OPEN_AI_API in .env");
    process.exit(1);
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Find sessions without synopses that have transcripts
  const sessions = await prisma.session.findMany({
    where: {
      synopsis: null,
      transcript: { isNot: null },
    },
    include: {
      transcript: { select: { fullText: true } },
      client: { select: { name: true } },
    },
    orderBy: { date: "asc" },
  });

  console.log(`Found ${sessions.length} sessions needing synopses`);

  let generated = 0;
  let errors = 0;

  for (const session of sessions) {
    if (!session.transcript?.fullText) continue;

    const transcript = session.transcript.fullText;
    const clientName = session.client.name;

    // Get prior synopses for context (last 3)
    const priorSessions = await prisma.session.findMany({
      where: {
        clientId: session.clientId,
        date: { lt: session.date },
        synopsis: { not: null },
      },
      orderBy: { date: "desc" },
      take: 3,
      select: { synopsis: true },
    });
    const priorSynopses = priorSessions
      .map((s) => s.synopsis!)
      .reverse();

    try {
      const contextBlock = priorSynopses.length > 0
        ? `\n\nPRIOR SESSION SYNOPSES (most recent first):\n${priorSynopses.map((s, i) => `--- Session ${i + 1} ---\n${s}`).join("\n\n")}`
        : "";

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a coaching intelligence assistant for an executive coach. Generate a concise session synopsis (150-200 words) from a coaching session transcript.

Focus on:
1. Key themes and topics discussed
2. Commitments and action items the client made
3. Emotional tone and energy level
4. Patterns or shifts from prior sessions (if context provided)
5. Recommended follow-up for the next session

Write in third person, present tense. Be specific about what was discussed, not generic. Use the client's first name. Do not include headers or bullet points — write as a flowing paragraph.`,
            },
            {
              role: "user",
              content: `Client: ${clientName}${contextBlock}\n\nCURRENT SESSION TRANSCRIPT:\n${transcript.slice(0, 15000)}`,
            },
          ],
          temperature: 0.3,
          max_tokens: 400,
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error(`  Error for ${clientName} (${session.date.toISOString().slice(0, 10)}): ${err.slice(0, 100)}`);
        errors++;
        continue;
      }

      const data = await resp.json();
      const synopsis = data.choices[0].message.content.trim();

      await prisma.session.update({
        where: { id: session.id },
        data: { synopsis },
      });

      generated++;
      if (generated % 10 === 0) {
        console.log(`  ${generated}/${sessions.length} synopses generated`);
      }
    } catch (err) {
      console.error(`  Error: ${err}`);
      errors++;
    }

    // Rate limit: ~500 RPM for gpt-4o-mini
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nSynopsis generation complete:`);
  console.log(`  Generated: ${generated}`);
  console.log(`  Errors: ${errors}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
