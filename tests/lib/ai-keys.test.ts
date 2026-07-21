import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptSecret } from "@/lib/secrets";

// The read half of the encryption flow: getOpenAIKey/getAnthropicKey must
// decrypt the stored CoachSettings key at runtime (this is what actually runs
// on every synopsis/embedding), tolerate a legacy plaintext row, and fall back
// to env vars when no key is stored.

const mocks = vi.hoisted(() => ({ settingsFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { coachSettings: { findFirst: mocks.settingsFindFirst } },
}));

import { getOpenAIKey, getAnthropicKey } from "@/lib/ai";

const KEY = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COACHIQ_SECRETS_KEY", KEY);
  // Clear the env fallbacks so tests control the source explicitly.
  vi.stubEnv("OPEN_AI_API", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("getOpenAIKey — decrypt-on-read", () => {
  it("decrypts an encrypted stored key", async () => {
    mocks.settingsFindFirst.mockResolvedValue({ openaiApiKey: encryptSecret("sk-real-openai") });
    expect(await getOpenAIKey()).toBe("sk-real-openai");
  });

  it("passes a legacy plaintext stored key through", async () => {
    mocks.settingsFindFirst.mockResolvedValue({ openaiApiKey: "sk-legacy-plaintext" });
    expect(await getOpenAIKey()).toBe("sk-legacy-plaintext");
  });

  it("falls back to the env var when no key is stored", async () => {
    mocks.settingsFindFirst.mockResolvedValue({ openaiApiKey: null });
    vi.stubEnv("OPEN_AI_API", "sk-from-env");
    expect(await getOpenAIKey()).toBe("sk-from-env");
  });

  it("falls back to env when there is no settings row at all", async () => {
    mocks.settingsFindFirst.mockResolvedValue(null);
    vi.stubEnv("OPENAI_API_KEY", "sk-env-alt");
    expect(await getOpenAIKey()).toBe("sk-env-alt");
  });

  it("throws when neither a stored key nor an env var is present", async () => {
    mocks.settingsFindFirst.mockResolvedValue({ openaiApiKey: null });
    await expect(getOpenAIKey()).rejects.toThrow(/No OpenAI API key configured/);
  });

  it("throws on an undecryptable stored key instead of silently using env", async () => {
    // Deliberate fail-loud: a key encrypted under a DIFFERENT COACHIQ_SECRETS_KEY
    // must raise, not quietly fall back to the env key and call a paid API with
    // the wrong credentials.
    const enc = encryptSecret("sk-real"); // under KEY
    vi.stubEnv("COACHIQ_SECRETS_KEY", "b".repeat(64)); // now the wrong key
    vi.stubEnv("OPENAI_API_KEY", "sk-env-fallback");
    mocks.settingsFindFirst.mockResolvedValue({ openaiApiKey: enc });
    await expect(getOpenAIKey()).rejects.toThrow(/different COACHIQ_SECRETS_KEY/);
  });
});

describe("getAnthropicKey — decrypt-on-read", () => {
  it("decrypts an encrypted stored key", async () => {
    mocks.settingsFindFirst.mockResolvedValue({ anthropicApiKey: encryptSecret("sk-ant-real") });
    expect(await getAnthropicKey()).toBe("sk-ant-real");
  });

  it("falls back to the env var when no key is stored", async () => {
    mocks.settingsFindFirst.mockResolvedValue({ anthropicApiKey: null });
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env");
    expect(await getAnthropicKey()).toBe("sk-ant-env");
  });

  it("throws when neither a stored key nor an env var is present", async () => {
    mocks.settingsFindFirst.mockResolvedValue(null);
    await expect(getAnthropicKey()).rejects.toThrow(/No Anthropic API key configured/);
  });
});
