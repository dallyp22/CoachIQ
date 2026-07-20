import { isEncrypted, decryptSecret } from "@/lib/secrets";

/**
 * The prefix every masked secret starts with. Shared so the PATCH route's
 * "don't re-save the mask" guard and the mask this module emits can never
 * drift apart — if they did, a masked read could be re-encrypted AS the key.
 */
export const MASK_PREFIX = "•••";

/** True when a value is a display mask (from maskCoachSecret), not a real key. */
export function isMasked(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(MASK_PREFIX);
}

/**
 * Read/display helpers for the practice-level secret columns on CoachSettings
 * (openaiApiKey, anthropicApiKey, stripeSecretKey).
 *
 * These three keys predate envelope encryption and shipped as plaintext. New
 * writes go through encryptSecret, but an un-backfilled row is still bare
 * plaintext — so every read has to tolerate BOTH shapes until the backfill
 * (scripts/backfill-coach-settings-secrets.ts) has run everywhere. A
 * decrypt-only read would throw on exactly the rows we are migrating away from.
 */

/**
 * Decrypt a stored secret, tolerating legacy plaintext.
 *
 * Detects the "v1:" envelope and decrypts it; passes anything else through
 * unchanged (a not-yet-backfilled plaintext key). Throws (via decryptSecret)
 * when an encrypted value will not authenticate — a consumer must fail loudly
 * rather than call a paid API with a garbage key.
 */
export function readCoachSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  return isEncrypted(stored) ? decryptSecret(stored) : stored;
}

/**
 * Mask a stored secret for display: the last four characters of the REAL key,
 * never the ciphertext. Masking the raw envelope would show four bytes of
 * base64 that change on every save and tell the coach nothing about which key
 * is set.
 *
 * Tolerant on purpose: a value that will not decrypt (wrong key, corruption)
 * must not 500 the settings page. Fall back to a full mask so the page renders
 * and the coach can simply overwrite the key.
 */
export function maskCoachSecret(stored: string | null | undefined): string | null {
  let plain: string | null;
  try {
    plain = readCoachSecret(stored);
  } catch {
    return MASK_PREFIX + "•••••"; // full mask; still isMasked()-recognized
  }
  if (!plain) return null;
  if (plain.length <= 8) return MASK_PREFIX + "•••••";
  return MASK_PREFIX + plain.slice(-4);
}
