import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  syncCalendarSessions: vi.fn(),
  deliverDueBriefs: vi.fn(),
}));

vi.mock("@/lib/calendar-sync", () => ({
  syncCalendarSessions: mocks.syncCalendarSessions,
}));

vi.mock("@/lib/deliver-briefs", () => ({
  deliverDueBriefs: mocks.deliverDueBriefs,
}));

import { GET } from "@/app/api/cron/workday-sync/route";

const SYNC_RESULT = { created: 2, linked: 1, skipped: 0, errors: [] as string[] };
const BRIEFS_RESULT = { status: "completed", generated: 1, skipped: 0 };

function makeRequest(authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/workday-sync", {
    headers: authHeader ? { authorization: authHeader } : undefined,
  });
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_VERCEL = process.env.VERCEL;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.CRON_SECRET = "test-secret";
  mocks.syncCalendarSessions.mockResolvedValue(SYNC_RESULT);
  mocks.deliverDueBriefs.mockResolvedValue(BRIEFS_RESULT);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = ORIGINAL_VERCEL;
});

describe("GET /api/cron/workday-sync — auth", () => {
  it("returns 401 when CRON_SECRET is set and no auth header is sent", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.syncCalendarSessions).not.toHaveBeenCalled();
    expect(mocks.deliverDueBriefs).not.toHaveBeenCalled();
  });

  it("returns 401 on a wrong bearer token", async () => {
    const res = await GET(makeRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(mocks.syncCalendarSessions).not.toHaveBeenCalled();
  });

  it("runs without any auth header when CRON_SECRET is unset (local dev)", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL;
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
  });

  it("fails closed (503) on Vercel when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL = "1";
    const res = await GET(makeRequest("Bearer anything"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Cron secret not configured" });
    expect(mocks.syncCalendarSessions).not.toHaveBeenCalled();
    expect(mocks.deliverDueBriefs).not.toHaveBeenCalled();
  });

  it("fails closed (503) on any non-Vercel production host when CRON_SECRET is unset", async () => {
    // The open path is a dev convenience only — a VPS/Docker `next start`
    // deployment must not leave cron endpoints publicly invocable.
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await GET(makeRequest());
      expect(res.status).toBe(503);
      expect(mocks.syncCalendarSessions).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("GET /api/cron/workday-sync — happy path", () => {
  it("runs both jobs and returns completed with both results", async () => {
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.calendarSync).toEqual(SYNC_RESULT);
    expect(body.briefs).toEqual(BRIEFS_RESULT);
    expect(body.errors).toBeUndefined();
    expect(body.timestamp).toEqual(expect.any(String));

    // Calendar window is past 72h (covers the weekend gap) → next 24h.
    // Assert direction, not just width — a swapped 24h-back/72h-ahead window
    // has the same width but misses the weekend backlog entirely.
    const now = Date.now();
    const [timeMin, timeMax] = mocks.syncCalendarSessions.mock.calls[0];
    expect(now - timeMin.getTime()).toBeGreaterThanOrEqual(72 * 60 * 60 * 1000 - 5000);
    expect(now - timeMin.getTime()).toBeLessThanOrEqual(72 * 60 * 60 * 1000 + 5000);
    expect(timeMax.getTime() - timeMin.getTime()).toBe(96 * 60 * 60 * 1000);
  });

  it("passes ONE shared deadline (~270s out) to both calendar sync and brief delivery", async () => {
    const before = Date.now();
    await GET(makeRequest("Bearer test-secret"));
    const syncDeadline = mocks.syncCalendarSessions.mock.calls[0][2];
    const briefsDeadline = mocks.deliverDueBriefs.mock.calls[0][0];
    expect(typeof syncDeadline).toBe("number");
    // Same budget spans both phases, so the cron's 300s isn't granted twice.
    expect(briefsDeadline).toBe(syncDeadline);
    expect(syncDeadline - before).toBeGreaterThan(250_000);
    expect(syncDeadline - before).toBeLessThanOrEqual(270_000 + 1000);
  });

  it("reports partial (200) when calendar sync returns per-event errors", async () => {
    mocks.syncCalendarSessions.mockResolvedValue({
      ...SYNC_RESULT,
      errors: ['Event "Coaching — Alex": unique constraint failed'],
    });
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("partial");
    expect(body.errors).toEqual([
      'calendar-sync: Event "Coaching — Alex": unique constraint failed',
    ]);
    // Brief delivery still ran
    expect(body.briefs).toEqual(BRIEFS_RESULT);
  });
});

describe("GET /api/cron/workday-sync — partial failure isolation", () => {
  it("still delivers briefs when calendar sync throws (partial, 200)", async () => {
    mocks.syncCalendarSessions.mockRejectedValue(new Error("Google API down"));
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("partial");
    expect(body.calendarSync).toBeNull();
    expect(body.briefs).toEqual(BRIEFS_RESULT);
    expect(body.errors).toEqual(["calendar-sync: Google API down"]);
    expect(mocks.deliverDueBriefs).toHaveBeenCalledTimes(1);
  });

  it("keeps the calendar sync result when brief delivery throws (partial, 200)", async () => {
    mocks.deliverDueBriefs.mockRejectedValue(new Error("DB unreachable"));
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("partial");
    expect(body.calendarSync).toEqual(SYNC_RESULT);
    expect(body.briefs).toBeNull();
    expect(body.errors).toEqual(["deliver-briefs: DB unreachable"]);
  });

  it("returns 500 when both jobs fail", async () => {
    mocks.syncCalendarSessions.mockRejectedValue(new Error("sync boom"));
    mocks.deliverDueBriefs.mockRejectedValue(new Error("briefs boom"));
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("partial");
    expect(body.errors).toEqual([
      "calendar-sync: sync boom",
      "deliver-briefs: briefs boom",
    ]);
  });

  it("normalizes non-Error throws to 'Unknown error' in both catch blocks", async () => {
    mocks.syncCalendarSessions.mockRejectedValue("string failure");
    mocks.deliverDueBriefs.mockRejectedValue({ code: 42 });
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("partial");
    expect(body.errors).toEqual([
      "calendar-sync: Unknown error",
      "deliver-briefs: Unknown error",
    ]);
  });
});

describe("GET /api/cron/workday-sync — per-brief error surfacing", () => {
  it("reports partial (200) when deliverDueBriefs completes with per-brief errors", async () => {
    mocks.deliverDueBriefs.mockResolvedValue({
      status: "completed",
      generated: 1,
      skipped: 0,
      failed: 1,
      errors: ["brief for client client-a: LLM unavailable"],
    });
    const res = await GET(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("partial");
    expect(body.errors).toEqual([
      "deliver-briefs: brief for client client-a: LLM unavailable",
    ]);
    // The briefs result itself is still returned in full
    expect(body.briefs.generated).toBe(1);
    expect(body.briefs.failed).toBe(1);
  });
});

describe("cron schedule invariants (vercel.json)", () => {
  // CRON_GAP_LOOKAHEAD_MINUTES (deliver-briefs.ts) and SYNC_LOOKBACK_HOURS
  // (workday-sync/route.ts) are sized to this exact schedule. If this test
  // fails, re-derive both constants from the new schedule before updating it.
  it("workday-sync runs at the schedule the lookahead/lookback constants assume", async () => {
    const { readFileSync } = await import("node:fs");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const workday = vercel.crons.find(
      (c: { path: string }) => c.path === "/api/cron/workday-sync"
    );
    expect(workday.schedule).toBe("0 12,18 * * 1-5");
  });

  it("invoice-generation fires at 12:05, inside the workday-sync Neon wake window", async () => {
    // Both route docstrings assume invoice-generation lands 5 minutes after
    // the 12:00 workday-sync run so the DB is already awake (the whole point
    // of this consolidation). Moving it breaks the double-wake cost model.
    const { readFileSync } = await import("node:fs");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const invoice = vercel.crons.find(
      (c: { path: string }) => c.path === "/api/cron/invoice-generation"
    );
    // Weekdays-only: sync doesn't run on weekends, so a Sat/Sun invoice run
    // would bill against unsynced Friday-afternoon sessions.
    expect(invoice.schedule).toBe("5 12 * * 1-5");
  });
});
