import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * searchSessions is shared by /api/search and the MCP search_sessions tool. Its
 * merge/method logic is testable without a DB by mocking the raw query helper
 * and forcing the embedding path to fail (so it falls back to full-text/client).
 */

const { raw } = vi.hoisted(() => ({ raw: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { $queryRawUnsafe: raw } }));
// No OpenAI key → generateEmbedding throws → semantic path falls back.
vi.mock("@/lib/ai", () => ({
  getOpenAIKey: vi.fn(async () => {
    throw new Error("no key");
  }),
}));

import { searchSessions } from "@/lib/search";

const row = (id: string) => ({
  session_id: id,
  client_name: "Acme",
  client_id: "c1",
  title: "t",
  date: new Date("2026-08-01T00:00:00Z"),
  excerpt: "e",
  recording_url: null,
  score: 1,
});

beforeEach(() => vi.clearAllMocks());

describe("searchSessions", () => {
  it("short-circuits on a blank query without touching the DB", async () => {
    expect(await searchSessions({ coachId: null, query: "   " })).toEqual({ results: [], method: "none" });
    expect(raw).not.toHaveBeenCalled();
  });

  it("labels the method 'client' when only client-name rows match (no content hits)", async () => {
    // call 1 = clientNameSearch → one row; call 2 = fullTextSearch → none.
    raw.mockResolvedValueOnce([row("s1")]).mockResolvedValueOnce([]);
    const r = await searchSessions({ coachId: "coach-kurt", query: "Acme" });
    expect(r.method).toBe("client");
    expect(r.results.map((x) => x.sessionId)).toEqual(["s1"]);
  });

  it("dedupes a session that matches both by client-name and by content, keeping it once, client-first", async () => {
    // clientNameSearch → s1; fullTextSearch → s1 (dup) + s2.
    raw.mockResolvedValueOnce([row("s1")]).mockResolvedValueOnce([row("s1"), row("s2")]);
    const r = await searchSessions({ coachId: "coach-kurt", query: "Acme" });
    expect(r.results.map((x) => x.sessionId)).toEqual(["s1", "s2"]);
    expect(r.method).toBe("fulltext");
  });

  it("caps results at the safe limit", async () => {
    raw.mockResolvedValueOnce([row("s1"), row("s2"), row("s3")]).mockResolvedValueOnce([]);
    const r = await searchSessions({ coachId: null, query: "Acme", limit: 2 });
    expect(r.results).toHaveLength(2);
  });
});
