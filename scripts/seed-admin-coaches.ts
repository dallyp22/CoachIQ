/**
 * Give existing non-coach operators an ADMIN coach row.
 *
 * Until multi-coach deploys, Clerk auth is presence-only: every account that
 * can sign in sees everything. Afterwards, only accounts with a coach row can
 * sign in at all. Anyone using CoachIQ today who is not the practice owner
 * needs a row here, or they hit /no-access the moment it ships.
 *
 * The addresses live in an environment variable rather than in the migration
 * because they are personal and this repository is public.
 *
 *   COACHIQ_ADMIN_EMAILS="you@example.com,ops@example.com" \
 *   DATABASE_URL_UNPOOLED=... npx tsx scripts/seed-admin-coaches.ts
 *
 * Optionally name them (order matches the emails):
 *   COACHIQ_ADMIN_NAMES="Dallas Polivka,Dallas (VS Insights)"
 *
 * Idempotent: an address that already has a coach row is left untouched,
 * including its role — this will not silently promote an existing COACH.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const emails = (process.env.COACHIQ_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));

  if (emails.length === 0) {
    console.error(
      'COACHIQ_ADMIN_EMAILS is empty. Example:\n  COACHIQ_ADMIN_EMAILS="you@example.com" npx tsx scripts/seed-admin-coaches.ts'
    );
    process.exit(1);
  }

  const names = (process.env.COACHIQ_ADMIN_NAMES || "").split(",").map((n) => n.trim());

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    for (const [i, loginEmail] of emails.entries()) {
      const existing = await prisma.coach.findUnique({
        where: { loginEmail },
        select: { id: true, name: true, role: true },
      });
      if (existing) {
        console.log(`${loginEmail} already exists as ${existing.role} — left unchanged.`);
        continue;
      }
      const coach = await prisma.coach.create({
        data: {
          name: names[i] || loginEmail,
          loginEmail,
          role: "ADMIN",
          status: "ACTIVE",
          // An admin has no recordings or calendar of their own to connect.
          inviteStatus: "OK",
          fathomStatus: "OK",
          calendarSyncEnabled: false,
        },
        select: { name: true },
      });
      console.log(`Seeded ADMIN ${coach.name} <${loginEmail}>.`);
    }

    const total = await prisma.coach.count();
    console.log(`${total} coach row(s) now exist.`);
    console.log(
      "Confirm every account that needs access has one — anyone missing gets /no-access after deploy."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
