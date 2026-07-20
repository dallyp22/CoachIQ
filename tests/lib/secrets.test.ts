import { describe, it, expect, vi, afterEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  encryptOptional,
  decryptOptional,
  isEncrypted,
} from "@/lib/secrets";

// Two distinct valid 32-byte keys, hex-encoded.
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function withKey(key: string) {
  vi.stubEnv("COACHIQ_SECRETS_KEY", key);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secrets — roundtrip", () => {
  it("decrypts what it encrypted", () => {
    withKey(KEY_A);
    const secret = "whsec_x6EV6NIAAz3ldclszNJTwrow";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("handles unicode and long values", () => {
    withKey(KEY_A);
    const secret = "kürt–ø🔑 " + "x".repeat(4000);
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV) that still decrypts", () => {
    withKey(KEY_A);
    const secret = "same-input";
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    // Identical plaintext must not produce identical stored bytes, or the DB
    // leaks which coaches share a secret value.
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(secret);
    expect(decryptSecret(b)).toBe(secret);
  });

  it("marks its output as encrypted and plain values as not", () => {
    withKey(KEY_A);
    expect(isEncrypted(encryptSecret("s"))).toBe(true);
    expect(isEncrypted("whsec_plaintext")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});

describe("secrets — tamper and wrong-key rejection", () => {
  it("rejects a ciphertext encrypted under a different key", () => {
    withKey(KEY_A);
    const stored = encryptSecret("routing-secret");
    withKey(KEY_B);
    expect(() => decryptSecret(stored)).toThrow(/different COACHIQ_SECRETS_KEY/);
  });

  it("rejects a flipped byte in the ciphertext body", () => {
    withKey(KEY_A);
    const stored = encryptSecret("routing-secret");
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptSecret("v1:" + raw.toString("base64"))).toThrow(/failed authentication/);
  });

  it("rejects a flipped byte in the auth tag", () => {
    withKey(KEY_A);
    const stored = encryptSecret("routing-secret");
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[12] ^= 0xff; // first byte of the tag
    expect(() => decryptSecret("v1:" + raw.toString("base64"))).toThrow(/failed authentication/);
  });

  it("rejects a flipped byte in the IV", () => {
    withKey(KEY_A);
    const stored = encryptSecret("routing-secret");
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[0] ^= 0xff;
    expect(() => decryptSecret("v1:" + raw.toString("base64"))).toThrow(/failed authentication/);
  });

  it("refuses to treat an unprefixed value as plaintext", () => {
    withKey(KEY_A);
    // The failure mode this guards: a legacy plaintext secret in the column
    // must raise, never silently flow through as a valid secret.
    expect(() => decryptSecret("whsec_legacy_plaintext")).toThrow(/not an encrypted secret/);
  });

  it("rejects a truncated envelope", () => {
    withKey(KEY_A);
    expect(() => decryptSecret("v1:" + Buffer.alloc(20).toString("base64"))).toThrow(/truncated or corrupt/);
  });
});

describe("secrets — key validation", () => {
  it("fails loudly when the key is missing rather than storing plaintext", () => {
    vi.stubEnv("COACHIQ_SECRETS_KEY", "");
    expect(() => encryptSecret("s")).toThrow(/COACHIQ_SECRETS_KEY is not set/);
    expect(() => encryptSecret("s")).toThrow(/openssl rand -hex 32/);
  });

  it("rejects a key that is too short", () => {
    withKey("abcd");
    expect(() => encryptSecret("s")).toThrow(/must be 32 bytes/);
  });

  it("rejects a non-hex key", () => {
    withKey("z".repeat(64));
    expect(() => encryptSecret("s")).toThrow(/must be 32 bytes/);
  });

  it("rejects an empty plaintext", () => {
    withKey(KEY_A);
    expect(() => encryptSecret("")).toThrow(/non-empty string/);
  });
});

describe("secrets — optional helpers", () => {
  it("passes null, undefined, and empty string through as null", () => {
    withKey(KEY_A);
    expect(encryptOptional(null)).toBeNull();
    expect(encryptOptional(undefined)).toBeNull();
    expect(encryptOptional("")).toBeNull();
    expect(decryptOptional(null)).toBeNull();
    expect(decryptOptional(undefined)).toBeNull();
    expect(decryptOptional("")).toBeNull();
  });

  it("roundtrips a present value", () => {
    withKey(KEY_A);
    const stored = encryptOptional("fathom-api-key");
    expect(isEncrypted(stored!)).toBe(true);
    expect(decryptOptional(stored)).toBe("fathom-api-key");
  });
});
