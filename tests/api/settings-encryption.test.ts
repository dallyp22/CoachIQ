import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isEncrypted, decryptSecret, encryptSecret } from "@/lib/secrets";

// The write boundary: PATCH /api/settings must encrypt every new API key at
// rest, and must NOT re-save the "•••1234" mask its own GET returns. The helper
// unit tests cover the crypto; this proves the route is actually wired to it.

const mocks = vi.hoisted(() => ({
  requireCoach: vi.fn(),
  settingsFindFirst: vi.fn(),
  settingsCreate: vi.fn(),
  settingsUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachSettings: {
      findFirst: mocks.settingsFindFirst,
      create: mocks.settingsCreate,
      update: mocks.settingsUpdate,
    },
  },
}));
vi.mock("@/lib/authz", () => ({
  requireCoach: mocks.requireCoach,
  authzResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 401 }),
}));

import { PATCH, GET } from "@/app/api/settings/route";

const KEY = "a".repeat(64);
const EXISTING = {
  id: "settings-1",
  defaultHourlyRate: 300,
  openaiApiKey: null,
  anthropicApiKey: null,
  stripeSecretKey: null,
};

function patch(body: unknown) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as never;
}

/** The `data` object the route asked Prisma to persist. */
function persisted() {
  return mocks.settingsUpdate.mock.calls[0][0].data as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COACHIQ_SECRETS_KEY", KEY);
  mocks.requireCoach.mockResolvedValue({ id: "coach-todd", role: "OWNER" });
  mocks.settingsFindFirst.mockResolvedValue(EXISTING);
  // Echo the persisted row back so the route can build its masked response.
  mocks.settingsUpdate.mockImplementation(async ({ data }: never) => ({
    ...EXISTING,
    ...(data as object),
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe("PATCH /api/settings — secrets encrypted at rest", () => {
  it("encrypts all three API keys before persisting them", async () => {
    const res = await PATCH(
      patch({
        openaiApiKey: "sk-openai-plaintext",
        anthropicApiKey: "sk-ant-plaintext",
        stripeSecretKey: "sk_live_plaintext",
      }),
    );
    expect(res.status).toBe(200);
    const data = persisted();

    for (const col of ["openaiApiKey", "anthropicApiKey", "stripeSecretKey"] as const) {
      // Stored as ciphertext, never the raw key...
      expect(isEncrypted(data[col])).toBe(true);
      expect(data[col]).not.toContain("plaintext");
    }
    // ...and it decrypts back to exactly what was sent.
    expect(decryptSecret(data.openaiApiKey)).toBe("sk-openai-plaintext");
    expect(decryptSecret(data.anthropicApiKey)).toBe("sk-ant-plaintext");
    expect(decryptSecret(data.stripeSecretKey)).toBe("sk_live_plaintext");
  });

  it("never returns a raw key in the response — only a mask", async () => {
    const res = await PATCH(patch({ openaiApiKey: "sk-openai-abcd1234" }));
    const json = await res.json();
    expect(json.settings.openaiApiKey).toBe("•••1234");
    expect(JSON.stringify(json)).not.toContain("sk-openai-abcd1234");
  });

  it("skips the mask for ALL secret fields, not just openai", async () => {
    // Each secret field has its own independent isMasked guard; a copy-paste
    // slip on any one would re-encrypt the "•••1234" mask AS the key.
    await PATCH(
      patch({
        openaiApiKey: "•••1111",
        anthropicApiKey: "•••2222",
        stripeSecretKey: "•••3333",
        fathomWebhookSecret: "•••4444",
        coachName: "Todd",
      }),
    );
    const data = persisted();
    expect(data.openaiApiKey).toBeUndefined();
    expect(data.anthropicApiKey).toBeUndefined();
    expect(data.stripeSecretKey).toBeUndefined();
    expect(data.fathomWebhookSecret).toBeUndefined();
    expect(data.coachName).toBe("Todd"); // real edits still applied
  });

  it("does NOT double-encrypt a value already in envelope form", async () => {
    // An admin re-submitting a "v1:…" ciphertext must be skipped, not
    // encryptSecret'd again (which would decrypt to the inner "v1:…" as the key).
    const alreadyCiphertext = encryptSecret("sk-openai-original");
    await PATCH(patch({ openaiApiKey: alreadyCiphertext }));
    const data = persisted();
    expect(data.openaiApiKey).toBeUndefined(); // skipped, not re-wrapped
  });

  it("encrypts fathomWebhookSecret and never returns it raw", async () => {
    const res = await PATCH(patch({ fathomWebhookSecret: "whsec_realsecret9999" }));
    const data = persisted();
    expect(isEncrypted(data.fathomWebhookSecret)).toBe(true);
    const json = await res.json();
    expect(json.settings.fathomWebhookSecret).toBe("•••9999");
    expect(JSON.stringify(json)).not.toContain("whsec_realsecret9999");
  });

  it("returns a structured 500 (not an opaque throw) when the secrets key is unusable", async () => {
    vi.stubEnv("COACHIQ_SECRETS_KEY", "not-a-valid-hex-key");
    const res = await PATCH(patch({ openaiApiKey: "sk-openai-plaintext" }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/secrets key/i);
    expect(mocks.settingsUpdate).not.toHaveBeenCalled(); // nothing persisted
  });

  it("rejects a non-admin and persists nothing", async () => {
    mocks.requireCoach.mockRejectedValue(new Error("forbidden"));
    const res = await PATCH(patch({ openaiApiKey: "sk-openai-plaintext" }));
    expect(res.status).toBe(401);
    expect(mocks.settingsUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings — masks encrypted keys, never leaks them", () => {
  it("returns the real key's last-4 mask, decrypted from ciphertext", async () => {
    mocks.settingsFindFirst.mockResolvedValue({
      ...EXISTING,
      openaiApiKey: encryptSecret("sk-openai-wxyz9876"),
      anthropicApiKey: encryptSecret("sk-ant-plaintext-legacy") /* still masks */,
      stripeSecretKey: null,
    });
    const res = await GET();
    const json = await res.json();
    expect(json.openaiApiKey).toBe("•••9876"); // real tail, not the envelope
    expect(json.stripeSecretKey).toBeNull();
    // The ciphertext must never appear in the response.
    expect(JSON.stringify(json)).not.toContain("v1:");
    expect(JSON.stringify(json)).not.toContain("sk-openai-wxyz9876");
  });

  it("creates a settings row when none exists, instead of 500ing", async () => {
    mocks.settingsFindFirst.mockResolvedValue(null);
    mocks.settingsCreate.mockResolvedValue(EXISTING);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.settingsCreate).toHaveBeenCalledOnce();
  });
});
