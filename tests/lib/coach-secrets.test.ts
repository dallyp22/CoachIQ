import { describe, it, expect, vi, afterEach } from "vitest";
import { readCoachSecret, maskCoachSecret, isMasked, MASK_PREFIX } from "@/lib/coach-secrets";
import { encryptSecret } from "@/lib/secrets";

// Valid 32-byte keys, hex-encoded.
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function withKey(key: string) {
  vi.stubEnv("COACHIQ_SECRETS_KEY", key);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readCoachSecret — transition tolerance", () => {
  it("decrypts an encrypted value", () => {
    withKey(KEY_A);
    const stored = encryptSecret("sk-real-openai-key");
    expect(readCoachSecret(stored)).toBe("sk-real-openai-key");
  });

  it("passes a legacy plaintext value through unchanged", () => {
    withKey(KEY_A);
    // The un-backfilled case: a bare plaintext key must NOT throw, or every
    // read on a not-yet-migrated row would fail.
    expect(readCoachSecret("sk-legacy-plaintext")).toBe("sk-legacy-plaintext");
  });

  it("returns null for null, undefined, and empty string", () => {
    withKey(KEY_A);
    expect(readCoachSecret(null)).toBeNull();
    expect(readCoachSecret(undefined)).toBeNull();
    expect(readCoachSecret("")).toBeNull();
  });

  it("throws when an encrypted value will not authenticate", () => {
    withKey(KEY_A);
    const stored = encryptSecret("sk-real-openai-key");
    withKey(KEY_B);
    // A consumer must fail loudly rather than call a paid API with garbage.
    expect(() => readCoachSecret(stored)).toThrow(/different COACHIQ_SECRETS_KEY/);
  });
});

describe("maskCoachSecret — displays the real key's last four, never ciphertext", () => {
  it("masks the decrypted key, not the envelope", () => {
    withKey(KEY_A);
    const stored = encryptSecret("sk-abcdefgh1234");
    // Must reflect the real key's tail, and must not leak the "v1:" envelope.
    expect(maskCoachSecret(stored)).toBe("•••1234");
  });

  it("is stable across re-encryptions of the same key (random IV changes the ciphertext)", () => {
    withKey(KEY_A);
    const a = encryptSecret("sk-abcdefgh1234");
    const b = encryptSecret("sk-abcdefgh1234");
    expect(a).not.toBe(b); // different ciphertext...
    expect(maskCoachSecret(a)).toBe(maskCoachSecret(b)); // ...same mask
  });

  it("masks a legacy plaintext value the same way", () => {
    withKey(KEY_A);
    expect(maskCoachSecret("sk-abcdefgh1234")).toBe("•••1234");
  });

  it("fully masks a short value without revealing length-4 tails", () => {
    withKey(KEY_A);
    expect(maskCoachSecret(encryptSecret("short"))).toBe("••••••••");
  });

  it("full-masks at exactly 8 chars and tails at 9 (threshold boundary)", () => {
    withKey(KEY_A);
    // Guards the `<= 8` threshold: an off-by-one to `< 8` would leak a tail
    // from an 8-char key. 8 → full mask, 9 → last-4.
    expect(maskCoachSecret(encryptSecret("abcd1234"))).toBe("••••••••");
    expect(maskCoachSecret(encryptSecret("xabcd1234"))).toBe("•••1234");
  });

  it("returns null for absent values", () => {
    withKey(KEY_A);
    expect(maskCoachSecret(null)).toBeNull();
    expect(maskCoachSecret(undefined)).toBeNull();
    expect(maskCoachSecret("")).toBeNull();
  });

  it("does not 500 on an undecryptable value — falls back to a full mask", () => {
    withKey(KEY_A);
    const stored = encryptSecret("sk-abcdefgh1234");
    withKey(KEY_B);
    // Settings page must still render even if a key was encrypted under an old
    // COACHIQ_SECRETS_KEY; the coach can simply overwrite it.
    expect(maskCoachSecret(stored)).toBe("••••••••");
  });

  it("produces a mask that trips the write-path sentinel guard", () => {
    withKey(KEY_A);
    // The PATCH route skips re-saving any value isMasked() recognizes. Both
    // mask shapes must satisfy that, or a masked read would be re-encrypted as
    // the key on the next save.
    expect(isMasked(maskCoachSecret(encryptSecret("sk-abcdefgh1234")))).toBe(true);
    expect(isMasked(maskCoachSecret(encryptSecret("short")))).toBe(true);
  });
});

describe("isMasked — the shared guard the PATCH route trusts", () => {
  it("recognizes both mask shapes maskCoachSecret can emit", () => {
    withKey(KEY_A);
    expect(isMasked(maskCoachSecret(encryptSecret("sk-abcdefgh1234")))).toBe(true); // "•••1234"
    expect(isMasked(maskCoachSecret(encryptSecret("short")))).toBe(true); // full mask
    expect(isMasked(MASK_PREFIX)).toBe(true);
  });

  it("does not mistake a real key for a mask", () => {
    // A genuine new key the coach types must be treated as a value to save.
    expect(isMasked("sk-ant-api03-realkey")).toBe(false);
    expect(isMasked("v1:someEncryptedEnvelope")).toBe(false);
    expect(isMasked(null)).toBe(false);
    expect(isMasked(undefined)).toBe(false);
  });
});
