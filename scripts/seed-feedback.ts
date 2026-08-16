/**
 * Seed the Feedback & Roadmap board with the real items sitting in Dallas's
 * inbox, so the module opens with a working pipeline instead of empty. Safe to
 * re-run: it skips any item whose title already exists.
 *
 *   npx tsx scripts/seed-feedback.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  }),
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

type Stage = "SUBMITTED" | "ACKNOWLEDGED" | "INVESTIGATING" | "PLANNED" | "IN_PROGRESS" | "SHIPPED" | "DECLINED";

async function findCoach(match: RegExp): Promise<{ id: string; name: string } | null> {
  const coaches = await prisma.coach.findMany({ select: { id: true, name: true, loginEmail: true } });
  return coaches.find((c) => match.test(c.name) || match.test(c.loginEmail)) ?? null;
}

async function main() {
  const owner =
    (await prisma.coach.findFirst({ where: { role: "OWNER" }, select: { id: true, name: true } })) ??
    (await prisma.coach.findFirst({ select: { id: true, name: true } }));
  if (!owner) {
    throw new Error("No coaches exist — seed coaches first.");
  }

  const kurt = (await findCoach(/kurt/i)) ?? owner;
  const todd = (await findCoach(/todd|zimbel/i)) ?? owner;
  const dallas = (await findCoach(/dallas|polivka/i)) ?? owner;

  // Each seed: item fields + an ordered stage history + optional team comments.
  const seeds: Array<{
    type: "BUG" | "FEATURE";
    title: string;
    body: string;
    submitter: { id: string };
    appVersion: string;
    history: Array<{ to: Stage; at: Date; by: string | null; note?: string }>;
    comments?: Array<{ at: Date; by: string | null; body: string }>;
    priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  }> = [
    {
      type: "BUG",
      title: "Not all my calendar appointments show up",
      body: "Some of my sessions are on my Google Calendar but don't appear in CoachIQ. A Monday 2:30 wasn't showing.",
      submitter: kurt,
      appVersion: "0.4.0.0",
      priority: "HIGH",
      history: [
        { to: "SUBMITTED", at: daysAgo(11), by: kurt.id },
        { to: "ACKNOWLEDGED", at: daysAgo(11), by: owner.id },
        { to: "INVESTIGATING", at: daysAgo(9), by: owner.id, note: "Reproduced — sessions titled without \"coaching\" were being filtered out." },
      ],
      comments: [
        {
          at: daysAgo(9),
          by: null,
          body:
            "Reproduced it. Sessions you titled without the word \"coaching\" were hidden by the calendar filter. Fix is written — you'll see this move to Shipped shortly.",
        },
      ],
    },
    {
      type: "BUG",
      title: "Simplify prospect tracking",
      body: "The pipeline has more steps than I use day to day. I'd like a simpler way to log where a prospect is without filling in every field.",
      submitter: todd,
      appVersion: "0.5.0.0",
      priority: "MEDIUM",
      history: [
        { to: "SUBMITTED", at: daysAgo(6), by: todd.id },
        { to: "ACKNOWLEDGED", at: daysAgo(5), by: owner.id },
      ],
      comments: [
        { at: daysAgo(5), by: null, body: "Got it — looking at what the leanest add-a-prospect flow looks like." },
      ],
    },
    {
      type: "FEATURE",
      title: "Better calendar view",
      body: "I'd like a week/day calendar view of my sessions inside CoachIQ, not just the day list.",
      submitter: todd,
      appVersion: "0.5.0.0",
      priority: "MEDIUM",
      history: [
        { to: "SUBMITTED", at: daysAgo(14), by: todd.id },
        { to: "ACKNOWLEDGED", at: daysAgo(13), by: owner.id },
        { to: "INVESTIGATING", at: daysAgo(9), by: owner.id },
        { to: "PLANNED", at: daysAgo(4), by: owner.id, note: "On the roadmap — starting with a week view." },
      ],
      comments: [
        { at: daysAgo(4), by: null, body: "Planned. A week view is the first cut; day view follows." },
      ],
    },
    {
      type: "FEATURE",
      title: "MCP connection to Claude",
      body: "Expose CoachIQ over MCP so I can ask Claude about clients, sessions, and billing directly.",
      submitter: dallas,
      appVersion: "0.5.0.0",
      history: [{ to: "SUBMITTED", at: daysAgo(2), by: dallas.id }],
    },
  ];

  for (const seed of seeds) {
    const exists = await prisma.feedbackItem.findFirst({ where: { title: seed.title }, select: { id: true } });
    if (exists) {
      console.log(`skip (exists): ${seed.title}`);
      continue;
    }

    const finalStage = seed.history[seed.history.length - 1].to;
    const reachedAck = seed.history.find((h) => h.to !== "SUBMITTED");
    const shipped = seed.history.find((h) => h.to === "SHIPPED");

    await prisma.$transaction(async (tx) => {
      const item = await tx.feedbackItem.create({
        data: {
          type: seed.type,
          title: seed.title,
          body: seed.body,
          stage: finalStage,
          priority: seed.priority ?? null,
          submittedById: seed.submitter.id,
          appVersion: seed.appVersion,
          pageUrl: "/",
          ackAt: reachedAck?.at ?? null,
          shippedAt: shipped?.at ?? null,
          shippedInVersion: shipped ? seed.appVersion : null,
          createdAt: seed.history[0].at,
        },
        select: { id: true },
      });

      for (let i = 0; i < seed.history.length; i++) {
        const h = seed.history[i];
        await tx.feedbackStageChange.create({
          data: {
            feedbackId: item.id,
            fromStage: i === 0 ? null : seed.history[i - 1].to,
            toStage: h.to,
            note: h.note ?? null,
            changedById: h.by,
            changedAt: h.at,
          },
        });
      }

      for (const c of seed.comments ?? []) {
        await tx.feedbackComment.create({
          data: { feedbackId: item.id, authorId: c.by, body: c.body, createdAt: c.at },
        });
      }
    });

    console.log(`seeded: ${seed.title} → ${finalStage} (by ${seed.submitter.id === owner.id ? owner.name : "coach"})`);
  }

  console.log("done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
