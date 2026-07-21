/**
 * Encrypt the practice-level API keys stored on CoachSettings.
 *
 * openaiApiKey, anthropicApiKey, and stripeSecretKey predate envelope
 * encryption and were written as plaintext. The app now encrypts new writes
 * (src/app/api/settings/route.ts) and decrypts tolerantly on read
 * (src/lib/coach-secrets.ts), so plaintext rows keep working — but they stay
 * readable in any DB dump until this backfill runs. This walks every
 * CoachSettings row and re-stores each plaintext key as ciphertext.
 *
 * Run AFTER deploying the encrypt-on-write change (so nothing writes fresh
 * plaintext behind the backfill):
 *
 *   DATABASE_URL_UNPOOLED=... COACHIQ_SECRETS_KEY=... \
 *   npx tsx scripts/backfill-coach-settings-secrets.ts
 *
 * The compare-and-swap matches on the plaintext value, so it appears as a bind
 * parameter. Run with Postgres statement logging OFF (no log_statement=all) and
 * no Prisma `log:['query']` — otherwise the plaintext keys land in query logs.
 * The PrismaClient below is created with no log config, which is safe.
 *
 * Idempotent: a value already in "v1:" envelope form is left untouched, so
 * re-running is a no-op. It never decrypts-then-re-encrypts an already
 * encrypted value, so it cannot double-wrap or corrupt a live key.
 *
 * Two safety properties beyond idempotency:
 *   - It authenticates every EXISTING ciphertext up front and aborts if any
 *     will not decrypt under the current COACHIQ_SECRETS_KEY, so a run against
 *     a database encrypted under a different key fails loudly instead of
 *     reporting a hollow success.
 *   - Each plaintext→ciphertext write is a compare-and-swap constrained to the
 *     exact plaintext it read. If an admin saves a replacement key between the
 *     read and the write, the CAS matches zero rows and the stale value is
 *     skipped rather than clobbering the newer key.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encryptSecret, decryptSecret, isEncrypted } from "../src/lib/secrets";

const SECRET_COLUMNS = [
  "openaiApiKey", "anthropicApiKey", "stripeSecretKey", "fathomWebhookSecret",
] as const;
type SecretColumn = (typeof SECRET_COLUMNS)[number];

async function main() {
  // Fail before touching the database if the key is missing or malformed,
  // rather than half-way through.
  encryptSecret("preflight");

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const rows = await prisma.coachSettings.findMany({
      select: {
        id: true,
        openaiApiKey: true,
        anthropicApiKey: true,
        stripeSecretKey: true,
        fathomWebhookSecret: true,
      },
    });

    if (rows.length === 0) {
      console.log("No CoachSettings rows found — nothing to backfill.");
      return;
    }

    // Pass 1 — authenticate every value already in envelope form BEFORE writing
    // anything. An all-encrypted database must still prove the deployed key can
    // read it; a wrong-key or corrupt ciphertext aborts here rather than being
    // silently counted as "already done".
    for (const row of rows) {
      for (const col of SECRET_COLUMNS) {
        const value = row[col];
        if (!value || !isEncrypted(value)) continue;
        try {
          decryptSecret(value);
        } catch (err) {
          console.error(
            `Row ${row.id} column ${col} is already encrypted but will NOT decrypt under the current ` +
              `COACHIQ_SECRETS_KEY (${(err as Error).message}). Aborting — this database was encrypted ` +
              `with a different key, or the value is corrupt.`
          );
          process.exit(1);
        }
      }
    }

    // Pass 2 — encrypt plaintext values with a compare-and-swap on the exact
    // plaintext we read, so a concurrent Settings save is never overwritten.
    let encryptedCount = 0;
    let skippedEncrypted = 0;
    let skippedConcurrent = 0;

    for (const row of rows) {
      for (const col of SECRET_COLUMNS) {
        const value = row[col];
        if (!value) continue; // null / empty — nothing to encrypt
        if (isEncrypted(value)) {
          skippedEncrypted++; // already ciphertext (and authenticated in pass 1)
          continue;
        }

        const ciphertext = encryptSecret(value);
        // CAS + verify in ONE atomic statement: updateManyAndReturn's RETURNING
        // hands back the exact bytes this write persisted. A separate re-read
        // would race a legitimate concurrent PATCH and could decrypt the newer
        // key, mistaking a safe concurrent save for corruption.
        // `as never` on the three dynamic-key objects below: Prisma's generated
        // input types reject a computed `[col]` key (they want the literal
        // column name), so the cast is the standard escape hatch. `col` is
        // constrained to the SECRET_COLUMNS tuple, so the runtime shape is
        // always a valid CoachSettings column — the cast suppresses a typing
        // limitation, not a real type error.
        const written = await prisma.coachSettings.updateManyAndReturn({
          // Only write if the column still holds the exact plaintext we read. A
          // concurrent PATCH (which always writes ciphertext now) changed it →
          // matches zero rows → we skip rather than clobber the newer key.
          where: { id: row.id, [col]: value } as never,
          data: { [col]: ciphertext } as never,
          select: { [col]: true } as never,
        });

        if (written.length === 0) {
          console.warn(
            `Row ${row.id} column ${col} changed under us (concurrent save) — left as-is. Re-run to pick it up.`
          );
          skippedConcurrent++;
          continue;
        }

        // Prove the value we just wrote round-trips under the app's key, so a
        // broken write surfaces here rather than as a failed OpenAI call.
        const stored = (written[0] as Record<string, string | null>)[col];
        if (!stored || decryptSecret(stored) !== value) {
          console.error(`Row ${row.id} column ${col} did not round-trip. Do NOT trust this run.`);
          process.exit(1);
        }
        encryptedCount++;
      }
    }

    console.log(
      `Backfill complete: encrypted ${encryptedCount} key(s), skipped ${skippedEncrypted} already-encrypted ` +
        `and ${skippedConcurrent} concurrently-changed key(s) across ${rows.length} CoachSettings row(s).`
    );
    console.log("Verified every newly-encrypted value decrypts under the current COACHIQ_SECRETS_KEY.");
    if (skippedConcurrent > 0) process.exit(2); // signal "re-run needed" to the operator
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
