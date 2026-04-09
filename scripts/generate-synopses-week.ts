/**
 * Generate AI synopses for sessions from the last 7 days that don't have one.
 *
 * Run: npx tsx scripts/generate-synopses-week.ts
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

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const sessions = await prisma.session.findMany({
    where: {
      synopsis: null,
      transcript: { isNot: null },
      date: { gte: oneWeekAgo },
    },
    include: {
      transcript: { select: { fullText: true } },
      client: { select: { name: true } },
    },
    orderBy: { date: "asc" },
  });

  console.log(`Found ${sessions.length} sessions from last week needing synopses`);

  let generated = 0;
  let errors = 0;

  for (const session of sessions) {
    if (!session.transcript?.fullText) continue;

    const transcript = session.transcript.fullText;
    const clientName = session.client.name;

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
    const priorSynopses = priorSessions.map((s) => s.synopsis!).reverse();

    try {
      const contextBlock =
        priorSynopses.length > 0
          ? "\n\nPRIOR SESSION SYNOPSES (most recent first):\n" +
            priorSynopses
              .map((s, i) => `--- Session ${i + 1} ---\n${s}`)
              .join("\n\n")
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
              content:
                "You are a coaching intelligence assistant for an executive coach. Generate a concise session synopsis (150-200 words) from a coaching session transcript.\n\nFocus on:\n1. Key themes and topics discussed\n2. Commitments and action items the client made\n3. Emotional tone and energy level\n4. Patterns or shifts from prior sessions (if context provided)\n5. Recommended follow-up for the next session\n\nWrite in third person, present tense. Be specific about what was discussed, not generic. Use the client's first name. Do not include headers or bullet points — write as a flowing paragraph.",
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
        console.error(
          `  Error for ${clientName} (${session.date.toISOString().slice(0, 10)}): ${err.slice(0, 100)}`
        );
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
      console.log(
        `  [${generated}] ${clientName} — ${session.date.toISOString().slice(0, 10)}`
      );
    } catch (err) {
      console.error(`  Error: ${err}`);
      errors++;
    }

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
