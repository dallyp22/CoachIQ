import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  generateForAllDueClients: vi.fn(),
}));

vi.mock("@/lib/billing/generate", () => ({
  generateForAllDueClients: mocks.generateForAllDueClients,
}));

import { GET } from "@/app/api/cron/invoice-generation/route";

function makeRequest(authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/invoice-generation", {
    headers: authHeader ? { authorization: authHeader } : undefined,
  });
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_VERCEL = process.env.VERCEL;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.CRON_SECRET = "test-secret";
  mocks.generateForAllDueClients.mockResolvedValue({ generated: 3, skipped: 1 });
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = ORIGINAL_VERCEL;
});

describe("GET /api/cron/invoice-generation — auth", () => {
  it("returns 401 on a wrong bearer token and does not generate invoices", async () => {
    const res = await GET(makeRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.generateForAllDueClients).not.toHaveBeenCalled();
  });

  it("fails closed (503) on Vercel when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL = "1";
    const res = await GET(makeRequest("Bearer anything"));
    expect(res.status).toBe(503);
    expect(mocks.generateForAllDueClients).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/invoice-generation — generation", () => {
  it("runs generation as cron source and spreads the result into the response", async () => {
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.generated).toBe(3);
    expect(body.skipped).toBe(1);
    expect(body.startedAt).toEqual(expect.any(String));
    expect(body.finishedAt).toEqual(expect.any(String));
    expect(mocks.generateForAllDueClients).toHaveBeenCalledWith({
      source: "cron",
      actor: null,
    });
  });

  it("returns 500 with ok false when generation throws", async () => {
    mocks.generateForAllDueClients.mockRejectedValue(new Error("DB unreachable"));
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("DB unreachable");
    expect(body.startedAt).toEqual(expect.any(String));
  });

  it("normalizes non-Error throws to 'Unknown error'", async () => {
    mocks.generateForAllDueClients.mockRejectedValue("string failure");
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Unknown error");
  });
});
