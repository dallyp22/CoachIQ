import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/cron/start-of-day/route";

function makeRequest(authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/start-of-day", {
    headers: authHeader ? { authorization: authHeader } : undefined,
  });
}

const ENV_KEYS = ["CRON_SECRET", "VERCEL", "VERCEL_URL", "NEXT_PUBLIC_APP_URL"] as const;
const originalEnv: Record<string, string | undefined> = {};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CRON_SECRET = "test-secret";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    json: async () => ({ status: "generated", sessions: [{ id: 1 }, { id: 2 }] }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("GET /api/cron/start-of-day — auth", () => {
  it("returns 401 when CRON_SECRET is set and no auth header is sent", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed (503) on Vercel when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL = "1";
    const res = await GET(makeRequest("Bearer anything"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Cron secret not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/start-of-day — daily brief trigger", () => {
  it("fetches /api/daily-brief?force=true without forwarding any headers (no secret leaves the function)", async () => {
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/daily-brief?force=true"
    );
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.sessions).toBe(2);
    expect(body.briefGenerated).toBe(true);
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it("prefers NEXT_PUBLIC_APP_URL over VERCEL_URL when both are set", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachiq.example.com";
    process.env.VERCEL_URL = "deploy-abc123.vercel.app";
    await GET(makeRequest("Bearer test-secret"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://coachiq.example.com/api/daily-brief?force=true"
    );
  });

  it("falls back to https://VERCEL_URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    process.env.VERCEL_URL = "deploy-abc123.vercel.app";
    await GET(makeRequest("Bearer test-secret"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://deploy-abc123.vercel.app/api/daily-brief?force=true"
    );
  });

  it("treats a set-but-empty NEXT_PUBLIC_APP_URL as unset (vercel env pull artifact)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "";
    process.env.VERCEL_URL = "deploy-abc123.vercel.app";
    await GET(makeRequest("Bearer test-secret"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://deploy-abc123.vercel.app/api/daily-brief?force=true"
    );
  });

  it("reports briefGenerated true for no_sessions and defaults sessions to 0", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ status: "no_sessions" }) });
    const res = await GET(makeRequest("Bearer test-secret"));
    const body = await res.json();
    expect(body.sessions).toBe(0);
    expect(body.briefGenerated).toBe(true);
  });

  it("reports briefGenerated false for any other daily-brief status", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ status: "cached", sessions: [] }) });
    const res = await GET(makeRequest("Bearer test-secret"));
    const body = await res.json();
    expect(body.briefGenerated).toBe(false);
  });

  it("returns 500 with the error message when the daily-brief fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ECONNREFUSED" });
  });

  it("normalizes non-Error throws to 'Unknown error'", async () => {
    fetchMock.mockResolvedValue({ json: async () => { throw "bad json"; } });
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unknown error" });
  });
});
