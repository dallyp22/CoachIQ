/**
 * Move the practice-wide Fathom webhook secret onto the OWNER's coach row.
 *
 * Before multi-coach, the webhook verified against
 * COACHIQ_FATHOM_WEBHOOK_SECRET from the environment. Afterwards it verifies
 * against coaches.fathomWebhookSecret, per coach. Without this backfill no
 * coach carries a secret, every incoming payload fails to resolve, and every
 * recording is rejected with a 401 until someone notices — Fathom stops
 * retrying, so those sessions are gone.
 *
 * Run AFTER the migration and BEFORE (or immediately with) the deploy:
 *
 *   DATABASE_URL_UNPOOLED=... COACHIQ_SECRETS_KEY=... \
 *   COACHIQ_FATHOM_WEBHOOK_SECRET=... npx tsx scripts/backfill-fathom-secret.ts
 *
 * Idempotent: re-running with the same secret is a no-op. Pass --force to
 * overwrite a secret that is already set.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encryptSecret, decryptOptional } from "../src/lib/secrets";

async function main() {
  const force = process.argv.includes("--force");
  const envSecret = process.env.COACHIQ_FATHOM_WEBHOOK_SECRET?.trim();

  if (!envSecret) {
    console.error("COACHIQ_FATHOM_WEBHOOK_SECRET is not set — nothing to backfill.");
    process.exit(1);
  }
  // Fail before touching the database if the key is missing or malformed,
  // rather than half-way through.
  encryptSecret("preflight");

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const owner = await prisma.coach.findFirst({
      where: { role: "OWNER" },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, loginEmail: true, fathomWebhookSecret: true },
    });
    if (!owner) {
      console.error("No OWNER coach found — run the multi-coach migration first.");
      process.exit(1);
    }

    if (owner.fathomWebhookSecret && !force) {
      let matches = false;
      try {
        matches = decryptOptional(owner.fathomWebhookSecret) === envSecret;
      } catch {
        // A secret encrypted under a different key. Say so rather than
        // silently leaving a value that cannot be decrypted at runtime.
      }
      console.log(
        matches
          ? `${owner.name} already has this exact secret stored. Nothing to do.`
          : `${owner.name} already has a DIFFERENT secret stored (or one that will not decrypt under the current COACHIQ_SECRETS_KEY). Re-run with --force to overwrite.`
      );
      process.exit(matches ? 0 : 1);
    }

    await prisma.coach.update({
      where: { id: owner.id },
      data: { fathomWebhookSecret: encryptSecret(envSecret), fathomStatus: "OK" },
    });

    // Prove it round-trips under the same key the app will use, so a broken
    // backfill surfaces here rather than as silently dropped recordings.
    const check = await prisma.coach.findUnique({
      where: { id: owner.id },
      select: { fathomWebhookSecret: true },
    });
    if (decryptOptional(check!.fathomWebhookSecret) !== envSecret) {
      console.error("Stored secret did not round-trip. Do NOT deploy.");
      process.exit(1);
    }

    console.log(`Backfilled the Fathom webhook secret onto ${owner.name} <${owner.loginEmail}>.`);
    console.log("Verified it decrypts under the current COACHIQ_SECRETS_KEY.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
