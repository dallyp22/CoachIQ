import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Envelope encryption for per-coach secrets stored in Postgres.
 *
 * Fathom API keys and webhook signing secrets are one-per-coach, so they
 * cannot live in environment variables the way the single-tenant secrets do.
 * They are encrypted with a single key held in COACHIQ_SECRETS_KEY, so a
 * database leak (Neon branch, backup, accidental dump) yields ciphertext.
 *
 * Stored format:  "v1:" + base64( iv ‖ authTag ‖ ciphertext )
 *
 *   ┌────────── stored string ──────────┐
 *   │ "v1:"  │ base64 of:               │
 *   │        │  iv (12) ‖ tag (16) ‖ ct │
 *   └────────┴──────────────────────────┘
 *
 * The "v1:" prefix does two jobs: it makes a future key rotation or algorithm
 * change expressible without ambiguity, and it lets decryptSecret refuse a
 * value that was never encrypted rather than silently treating stored
 * plaintext as a valid secret.
 *
 * AES-256-GCM is authenticated: a tampered ciphertext, tag, or IV fails on
 * final() rather than returning garbage.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce — the GCM standard
const TAG_BYTES = 16;
const PREFIX = "v1:";

const GENERATE_HINT = "Generate one with `openssl rand -hex 32` and set it in every environment.";

/**
 * Load and validate the master key. Throws loudly rather than falling back to
 * plaintext: a missing key must fail the write, never silently store a secret
 * in the clear.
 */
function getKey(): Buffer {
  const raw = process.env.COACHIQ_SECRETS_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error(`COACHIQ_SECRETS_KEY is not set — coach secrets cannot be encrypted or decrypted. ${GENERATE_HINT}`);
  }
  // Invalid hex decodes to a short buffer (Buffer.from stops at the first bad
  // pair), so the length check catches malformed keys as well as short ones.
  const key = Buffer.from(raw.trim(), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `COACHIQ_SECRETS_KEY must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex characters (decoded ${key.length} bytes). ${GENERATE_HINT}`
    );
  }
  return key;
}

/** True when a stored value is in the encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret requires a non-empty string.");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    throw new Error(`Value is not an encrypted secret (missing "${PREFIX}" prefix) — refusing to treat it as plaintext.`);
  }
  const blob = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted secret is truncated or corrupt.");
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), blob.subarray(0, IV_BYTES));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM authentication failure: wrong key, or the stored bytes were altered.
    throw new Error(
      "Coach secret failed authentication — it was encrypted with a different COACHIQ_SECRETS_KEY, or the stored value has been altered."
    );
  }
}

/** Nullable passthrough for optional columns (fathomApiKey, fathomWebhookSecret). */
export function encryptOptional(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  return encryptSecret(plaintext);
}

export function decryptOptional(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  return decryptSecret(stored);
}
