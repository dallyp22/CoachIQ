import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  coachFindMany: vi.fn(),
  clientCount: vi.fn(),
  sessionCount: vi.fn(),
  sessionFindMany: vi.fn(),
  timeEntryFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coach: { findMany: mocks.coachFindMany },
    client: { count: mocks.clientCount },
    session: { count: mocks.sessionCount, findMany: mocks.sessionFindMany },
    timeEntry: { findMany: mocks.timeEntryFindMany },
  },
}));

// getPracticeOverview doesn't touch the calendar, but the module imports it.
vi.mock("@/lib/google-calendar", () => ({
  getCalendar: () => ({ calendars: { get: vi.fn() } }),
  DEFAULT_COACHING_FILTER: "coaching",
}));

import { getPracticeOverview } from "@/lib/practice-stats";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPracticeOverview", () => {
  it("scopes every per-coach aggregate to that coach's clients and reduces totals", async () => {
    mocks.coachFindMany.mockResolvedValue([
      { id: "coach-a", name: "Todd" },
      { id: "coach-b", name: "Kurt" },
    ]);
    mocks.clientCount.mockImplementation(({ where }: { where: { coachId: string } }) =>
      Promise.resolve(where.coachId === "coach-a" ? 5 : 7)
    );
    mocks.sessionCount.mockResolvedValue(3);
    mocks.sessionFindMany.mockImplementation(({ where }: { where: { client: { coachId: string } } }) =>
      Promise.resolve(
        where.client.coachId === "coach-a"
          ? [{ billableMinutes: 60 }, { billableMinutes: 30 }] // 1.5h
          : [{ billableMinutes: 90 }] // 1.5h
      )
    );
    mocks.timeEntryFindMany.mockImplementation(({ where }: { where: { client: { coachId: string } } }) =>
      Promise.resolve(
        where.client.coachId === "coach-a"
          ? [{ amount: 200 }, { amount: 50.5 }]
          : [{ amount: 1000 }]
      )
    );

    const rows = await getPracticeOverview();

    expect(rows).toEqual([
      { coachId: "coach-a", name: "Todd", activeClients: 5, sessionsThisWeek: 3, hoursThisMonth: 1.5, unbilled: 250.5 },
      { coachId: "coach-b", name: "Kurt", activeClients: 7, sessionsThisWeek: 3, hoursThisMonth: 1.5, unbilled: 1000 },
    ]);

    // Tenant boundary: session/timeEntry queries always filter by client.coachId.
    for (const call of mocks.sessionFindMany.mock.calls) {
      expect(call[0].where.client.coachId).toMatch(/^coach-[ab]$/);
    }
    for (const call of mocks.timeEntryFindMany.mock.calls) {
      expect(call[0].where.status).toBe("UNBILLED");
      expect(call[0].where.client.coachId).toMatch(/^coach-[ab]$/);
    }
  });

  it("excludes inactive coaches from the roster", async () => {
    mocks.coachFindMany.mockResolvedValue([]);
    const rows = await getPracticeOverview();
    expect(rows).toEqual([]);
    expect(mocks.coachFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { not: "INACTIVE" } } })
    );
  });
});
