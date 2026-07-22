import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase 5: the daily brief must use the VIEWED coach's own calendar + email set
// (resolveCoachConfig), not the singleton CoachSettings. These tests exercise
// the LLM-free paths (not-configured guard + no_sessions) to verify that wiring.

const mocks = vi.hoisted(() => ({
  requireCoach: vi.fn(),
  coachSettingsFindFirst: vi.fn(),
  coachFindUnique: vi.fn(),
  clientFindMany: vi.fn(),
  eventsList: vi.fn(),
  filterCoachingEvents: vi.fn(),
  hasCalendarCredentials: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachSettings: { findFirst: mocks.coachSettingsFindFirst },
    coach: { findUnique: mocks.coachFindUnique },
    client: { findMany: mocks.clientFindMany },
  },
}));

// Keep the real scopeCoachId / clientWhere / resolveCoachConfig / authzResponse;
// only requireCoach needs a mock (it reaches Clerk).
vi.mock("@/lib/authz", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/authz")>();
  return { ...actual, requireCoach: mocks.requireCoach };
});

vi.mock("@/lib/google-calendar", () => ({
  getCalendar: () => ({ events: { list: mocks.eventsList } }),
  filterCoachingEvents: mocks.filterCoachingEvents,
  eventDurationMinutes: () => 60,
  hasCalendarCredentials: mocks.hasCalendarCredentials,
}));

// Fail loudly if the LLM path is ever reached in these tests.
vi.mock("@/lib/ai", () => ({
  getChatProvider: () => {
    throw new Error("LLM should not be called on the no_sessions path");
  },
}));

import { GET } from "@/app/api/daily-brief/route";

const OWNER = { id: "coach-a", role: "OWNER" as const };
const briefCoachA = {
  id: "coach-a",
  loginEmail: "coach@cocreate.com",
  workEmails: [],
  googleCalendarId: "cal-a",
  coachingTitleFilter: "coaching",
  calendarSyncEnabled: true,
  defaultHourlyRate: null,
};

function req(coachIdParam?: string) {
  const url = coachIdParam
    ? `http://localhost/api/daily-brief?coachId=${coachIdParam}`
    : "http://localhost/api/daily-brief";
  // The route reads request.nextUrl.searchParams (a NextRequest field).
  return { nextUrl: new URL(url) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCoach.mockResolvedValue(OWNER);
  mocks.coachSettingsFindFirst.mockResolvedValue({ coachingTitleFilter: "coaching", timezone: "America/Chicago" });
  mocks.coachFindUnique.mockResolvedValue(briefCoachA);
  mocks.hasCalendarCredentials.mockReturnValue(true);
  mocks.eventsList.mockResolvedValue({ data: { items: [] } });
  mocks.filterCoachingEvents.mockImplementation((e: unknown[]) => e);
  mocks.clientFindMany.mockResolvedValue([]);
});

describe("GET /api/daily-brief — per-coach calendar", () => {
  it("fetches the viewed coach's OWN calendar id", async () => {
    await GET(req());
    expect(mocks.coachFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "coach-a" } })
    );
    expect(mocks.eventsList.mock.calls[0][0].calendarId).toBe("cal-a");
  });

  it("resolves another coach's calendar when an owner passes ?coachId", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...briefCoachA, id: "coach-b", googleCalendarId: "cal-b" });
    await GET(req("coach-b"));
    expect(mocks.coachFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "coach-b" } })
    );
    expect(mocks.eventsList.mock.calls[0][0].calendarId).toBe("cal-b");
  });

  it("returns 400 when the viewed coach has no calendar configured", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...briefCoachA, googleCalendarId: null });
    const res = await GET(req());
    expect(res.status).toBe(400);
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("returns no_sessions (no LLM call) when the coach has no coaching events today", async () => {
    const res = await GET(req());
    const json = await res.json();
    expect(json.status).toBe("no_sessions");
  });
});
