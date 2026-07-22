import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  clientFindUnique: vi.fn(),
  prepBriefCreate: vi.fn(),
  getChatProvider: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    client: { findUnique: mocks.clientFindUnique },
    prepBrief: { create: mocks.prepBriefCreate },
  },
}));

vi.mock("@/lib/ai", () => ({ getChatProvider: mocks.getChatProvider }));

import { generatePrepBrief } from "@/lib/prep-brief";

function clientWith(coach: { name: string } | null) {
  return {
    id: "client-a",
    name: "Alice",
    company: "Acme",
    sessionCount: 3,
    hourlyRate: 200,
    meetingCadence: "BIWEEKLY",
    coach,
    sessions: [
      { id: "s1", date: new Date("2026-01-01"), title: "Session", synopsis: "did things", actionItems: [] },
    ],
  };
}

/** The system prompt sent to the model. */
function sentSystemPrompt(): string {
  const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
  return body.messages.find((m: { role: string }) => m.role === "system").content;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getChatProvider.mockResolvedValue({ apiUrl: "https://x/api", apiKey: "k", defaultModel: "m" });
  mocks.prepBriefCreate.mockResolvedValue({ id: "brief-1" });
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "the brief" } }] }),
  }) as never;
});

afterEach(() => vi.restoreAllMocks());

describe("generatePrepBrief — addresses the owning coach by name", () => {
  it("uses the client's coach name in the prompt, not a hardcoded 'Todd'", async () => {
    mocks.clientFindUnique.mockResolvedValue(clientWith({ name: "Kurt Ford" }));
    await generatePrepBrief("client-a", new Date());
    const prompt = sentSystemPrompt();
    expect(prompt).toContain("Kurt Ford");
    expect(prompt).not.toContain("Todd");
  });

  it("falls back to 'the coach' when the coach has no name", async () => {
    mocks.clientFindUnique.mockResolvedValue(clientWith(null));
    await generatePrepBrief("client-a", new Date());
    const prompt = sentSystemPrompt();
    expect(prompt).toContain("the coach");
    expect(prompt).not.toContain("Todd");
  });
});
