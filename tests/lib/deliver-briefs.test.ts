import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  coachSettingsFindFirst: vi.fn(),
  coachFindMany: vi.fn(),
  clientFindMany: vi.fn(),
  prepBriefFindFirst: vi.fn(),
  eventsList: vi.fn(),
  hasCalendarCredentials: vi.fn(),
  filterCoachingEvents: vi.fn(),
  generatePrepBrief: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachSettings: { findFirst: mocks.coachSettingsFindFirst },
    coach: { findMany: mocks.coachFindMany },
    client: { findMany: mocks.clientFindMany },
    prepBrief: { findFirst: mocks.prepBriefFindFirst },
  },
}));

vi.mock("@/lib/google-calendar", () => ({
  getCalendar: () => ({ events: { list: mocks.eventsList } }),
  filterCoachingEvents: mocks.filterCoachingEvents,
  hasCalendarCredentials: mocks.hasCalendarCredentials,
}));

vi.mock("@/lib/prep-brief", () => ({
  generatePrepBrief: mocks.generatePrepBrief,
}));

// resolveCoachConfig is NOT mocked — the real one runs, so these tests also
// verify that a coach's own calendar id, title filter, and email set drive the
// per-coach fetch/match.
import { deliverDueBriefs } from "@/lib/deliver-briefs";

// Practice-wide defaults. Calendar id / title filter / coach email now live on
// the COACH, resolved over these fallbacks by resolveCoachConfig.
const settings = {
  briefDeliveryMinutes: 30,
  coachingTitleFilter: "coaching",
  timezone: "America/Chicago",
  defaultHourlyRate: null,
};

const coachA = {
  id: "coach-a",
  loginEmail: "coach@cocreate.com",
  workEmails: [] as string[],
  googleCalendarId: "cal-a",
  coachingTitleFilter: "coaching",
  calendarSyncEnabled: true,
  defaultHourlyRate: null,
};

const coachB = {
  id: "coach-b",
  loginEmail: "kurt@cocreate.com",
  workEmails: [] as string[],
  googleCalendarId: "cal-b",
  coachingTitleFilter: "coaching",
  calendarSyncEnabled: true,
  defaultHourlyRate: null,
};

const clientA = {
  id: "client-a",
  email: "alice@example.com",
  secondaryEmails: ["alice.work@corp.com"],
  sessionCount: 5,
};

const clientB = {
  id: "client-b",
  email: "bob@example.com",
  secondaryEmails: [] as string[],
  sessionCount: 3,
};

function makeEvent(opts: {
  startISO?: string | null;
  attendees?: Array<{ email?: string; resource?: boolean }>;
} = {}) {
  const startISO =
    opts.startISO === undefined
      ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
      : opts.startISO;
  return {
    summary: "Coaching: session",
    attendees: opts.attendees,
    start: startISO ? { dateTime: startISO } : {},
  };
}

function arrange(opts: {
  settings?: unknown;
  coaches?: unknown[];
  credentials?: boolean;
  events?: unknown[];
  eventsByCalendar?: Record<string, unknown[]>;
  clients?: unknown[];
  clientsByCoach?: Record<string, unknown[]>;
  existingBrief?: unknown;
} = {}) {
  mocks.coachSettingsFindFirst.mockResolvedValue(
    "settings" in opts ? opts.settings : settings
  );
  mocks.coachFindMany.mockResolvedValue(opts.coaches ?? [coachA]);
  mocks.hasCalendarCredentials.mockReturnValue(opts.credentials ?? true);
  if (opts.eventsByCalendar) {
    mocks.eventsList.mockImplementation(async ({ calendarId }: { calendarId: string }) => ({
      data: { items: opts.eventsByCalendar![calendarId] ?? [] },
    }));
  } else {
    mocks.eventsList.mockResolvedValue({ data: { items: opts.events ?? [] } });
  }
  // Pass-through by default so tests control the event set directly
  mocks.filterCoachingEvents.mockImplementation((events: unknown[]) => events);
  if (opts.clientsByCoach) {
    mocks.clientFindMany.mockImplementation(async ({ where }: { where: { coachId: string } }) =>
      opts.clientsByCoach![where.coachId] ?? []
    );
  } else {
    mocks.clientFindMany.mockResolvedValue(opts.clients ?? [clientA]);
  }
  mocks.prepBriefFindFirst.mockResolvedValue(opts.existingBrief ?? null);
  mocks.generatePrepBrief.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Restores spied implementations (console.error, and Date.now in the
  // time-budget test) so no test leaks a fake clock into the next one.
  vi.restoreAllMocks();
});

describe("deliverDueBriefs — configuration guards", () => {
  it("skips when no coach has a configured calendar", async () => {
    arrange({ coaches: [] });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "skipped", reason: "Calendar not configured" });
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("skips a coach in-loop when its resolved googleCalendarId is null", async () => {
    arrange({ coaches: [{ ...coachA, googleCalendarId: null }] });
    const result = await deliverDueBriefs();
    expect(result.status).toBe("skipped");
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("skips a coach whose calendarSyncEnabled is false", async () => {
    arrange({ coaches: [{ ...coachA, calendarSyncEnabled: false }] });
    const result = await deliverDueBriefs();
    expect(result.status).toBe("skipped");
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("skips when calendar credentials are missing (before touching coaches)", async () => {
    arrange({ credentials: false });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "skipped", reason: "Calendar not configured" });
    expect(mocks.eventsList).not.toHaveBeenCalled();
    expect(mocks.coachFindMany).not.toHaveBeenCalled();
  });
});

describe("deliverDueBriefs — multi-coach iteration and isolation", () => {
  it("processes each coach's OWN calendar and only that coach's clients", async () => {
    arrange({
      coaches: [coachA, coachB],
      eventsByCalendar: {
        "cal-a": [makeEvent({ attendees: [{ email: clientA.email }] })],
        "cal-b": [makeEvent({ attendees: [{ email: clientB.email }] })],
      },
      clientsByCoach: { "coach-a": [clientA], "coach-b": [clientB] },
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 2, skipped: 0, failed: 0, errors: [] });

    // Each coach's own calendar was fetched...
    const calendarIds = mocks.eventsList.mock.calls.map((c) => c[0].calendarId).sort();
    expect(calendarIds).toEqual(["cal-a", "cal-b"]);
    // ...and the client query was scoped to each coach's id.
    const coachIds = mocks.clientFindMany.mock.calls.map((c) => c[0].where.coachId).sort();
    expect(coachIds).toEqual(["coach-a", "coach-b"]);
    expect(mocks.generatePrepBrief).toHaveBeenCalledWith("client-a", expect.any(Date));
    expect(mocks.generatePrepBrief).toHaveBeenCalledWith("client-b", expect.any(Date));
  });

  it("does NOT brief another coach's client that appears on this coach's calendar", async () => {
    // coachA's calendar has an event whose only attendee is coachB's client.
    // Because coachA's client query is scoped to coach-a, there is no match —
    // the tenant boundary. A global client load would wrongly brief client-b.
    arrange({
      coaches: [coachA],
      eventsByCalendar: { "cal-a": [makeEvent({ attendees: [{ email: clientB.email }] })] },
      clientsByCoach: { "coach-a": [clientA] },
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 1, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).not.toHaveBeenCalled();
  });
});

describe("deliverDueBriefs — lookahead window", () => {
  it("floors the lookahead at 6.5h and looks back 1h for failed-run recovery", async () => {
    const before = Date.now();
    arrange({ settings: { ...settings, briefDeliveryMinutes: 30 } });
    await deliverDueBriefs();
    const args = mocks.eventsList.mock.calls[0][0];
    const windowMs =
      new Date(args.timeMax).getTime() - new Date(args.timeMin).getTime();
    // 1h recovery lookback + 6.5h cron-gap lookahead
    expect(windowMs).toBe((60 + 6 * 60 + 30) * 60 * 1000);
    // Direction: timeMin sits ~1h in the past, not the future
    const lookbackMs = before - new Date(args.timeMin).getTime();
    expect(lookbackMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
    expect(lookbackMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
    expect(args.calendarId).toBe("cal-a");
    // Without the cap the Google default (250) applies and the truncation
    // warning below becomes unreachable in practice.
    expect(args.maxResults).toBe(25);
  });

  it("passes the raw event list and the coach's title filter to filterCoachingEvents", async () => {
    const events = [makeEvent({ attendees: [{ email: clientA.email }] })];
    arrange({ events });
    await deliverDueBriefs();
    expect(mocks.filterCoachingEvents).toHaveBeenCalledWith(events, "coaching");
  });

  it("uses briefDeliveryMinutes when it exceeds the 6.5h floor", async () => {
    arrange({ settings: { ...settings, briefDeliveryMinutes: 600 } });
    // Also cover the missing-items fallback: Google can return data with no items
    mocks.eventsList.mockResolvedValue({ data: {} });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 0, failed: 0, errors: [] });
    const args = mocks.eventsList.mock.calls[0][0];
    const windowMs =
      new Date(args.timeMax).getTime() - new Date(args.timeMin).getTime();
    // 1h recovery lookback + the 600-minute custom lookahead
    expect(windowMs).toBe((60 + 600) * 60 * 1000);
  });

  it("re-covers a recently started session (failed prior run) but skips stale ones", async () => {
    // timeMin filters on event END, so a session that started long ago can
    // still appear in the response; only starts within the 1h lookback get
    // a brief.
    const startedRecently = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const startedStale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    arrange({
      events: [
        makeEvent({ startISO: startedRecently, attendees: [{ email: clientA.email }] }),
        makeEvent({ startISO: startedStale, attendees: [{ email: clientA.email }] }),
      ],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 1, skipped: 1, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).toHaveBeenCalledTimes(1);
    expect(mocks.generatePrepBrief).toHaveBeenCalledWith(
      "client-a",
      new Date(startedRecently)
    );
  });
});

describe("deliverDueBriefs — client matching", () => {
  it("skips events with no attendee matching a client (or no attendees at all)", async () => {
    arrange({
      events: [
        makeEvent({ attendees: [{ email: "stranger@nowhere.com" }] }),
        makeEvent(), // attendees undefined → `?? []` fallback
      ],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 2, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).not.toHaveBeenCalled();
  });

  it("briefs a matched client even if the denormalized sessionCount drifted to 0", async () => {
    // The client query already requires a synopsis-bearing session — the
    // real generatePrepBrief precondition. The counter must not gate briefs.
    arrange({
      clients: [{ ...clientA, sessionCount: 0 }],
      events: [makeEvent({ attendees: [{ email: clientA.email }] })],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 1, skipped: 0, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).toHaveBeenCalledTimes(1);
  });

  it("matches a client via a secondary email (case-insensitive)", async () => {
    arrange({
      events: [makeEvent({ attendees: [{ email: "Alice.Work@Corp.com" }] })],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 1, skipped: 0, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).toHaveBeenCalledWith("client-a", expect.any(Date));
  });

  it("ignores the coach's own emails (login + work) and resource attendees when matching", async () => {
    arrange({
      coaches: [{ ...coachA, workEmails: ["coach.alt@cocreate.com"] }],
      events: [
        makeEvent({
          attendees: [
            { email: coachA.loginEmail },
            { email: "coach.alt@cocreate.com" }, // a work email — also excluded
            { email: "room-1@resource.calendar.google.com", resource: true },
          ],
        }),
      ],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 1, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).not.toHaveBeenCalled();
  });

  it("skips events without a concrete start.dateTime (all-day events)", async () => {
    arrange({
      events: [makeEvent({ startISO: null, attendees: [{ email: clientA.email }] })],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 1, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).not.toHaveBeenCalled();
  });
});

describe("deliverDueBriefs — dedup and generation", () => {
  it("skips when a brief already exists within 1 hour of the session start", async () => {
    const startISO = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    arrange({
      events: [makeEvent({ startISO, attendees: [{ email: clientA.email }] })],
      existingBrief: { id: "brief-1" },
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 1, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).not.toHaveBeenCalled();

    // Dedup query is scoped to the client and a ±1h window around the start
    const where = mocks.prepBriefFindFirst.mock.calls[0][0].where;
    expect(where.clientId).toBe("client-a");
    const start = new Date(startISO).getTime();
    expect(where.targetSessionDate.gte.getTime()).toBe(start - 60 * 60 * 1000);
    expect(where.targetSessionDate.lte.getTime()).toBe(start + 60 * 60 * 1000);
  });

  it("generates a brief for a matched, non-duplicate session", async () => {
    const startISO = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    arrange({
      events: [makeEvent({ startISO, attendees: [{ email: clientA.email }] })],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 1, skipped: 0, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).toHaveBeenCalledWith(
      "client-a",
      new Date(startISO)
    );
  });

  it("counts a generatePrepBrief failure as failed, surfaces the error, and continues", async () => {
    arrange({
      clients: [clientA, clientB],
      events: [
        makeEvent({ attendees: [{ email: clientA.email }] }),
        makeEvent({ attendees: [{ email: clientB.email }] }),
      ],
    });
    mocks.generatePrepBrief
      .mockRejectedValueOnce(new Error("LLM unavailable"))
      .mockResolvedValueOnce(undefined);

    const result = await deliverDueBriefs();
    expect(result).toEqual({
      status: "completed",
      generated: 1,
      skipped: 0,
      failed: 1,
      errors: ["brief for client client-a: LLM unavailable"],
    });
    expect(mocks.generatePrepBrief).toHaveBeenCalledTimes(2);
  });

  it("normalizes a non-Error throw from generatePrepBrief to Unknown error", async () => {
    arrange({
      events: [makeEvent({ attendees: [{ email: clientA.email }] })],
    });
    mocks.generatePrepBrief.mockRejectedValueOnce("string rejection");

    const result = await deliverDueBriefs();
    expect(result).toEqual({
      status: "completed",
      generated: 0,
      skipped: 0,
      failed: 1,
      errors: ["brief for client client-a: Unknown error"],
    });
  });
});

describe("deliverDueBriefs — client eligibility query", () => {
  it("loads only this coach's non-churned, synopsis-bearing clients", async () => {
    arrange({ events: [] });
    await deliverDueBriefs();
    expect(mocks.clientFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          coachId: "coach-a",
          status: { not: "CHURNED" },
          sessions: { some: { synopsis: { not: null } } },
        },
      })
    );
  });
});

describe("deliverDueBriefs — limits and fallbacks", () => {
  it("falls back to a 30-minute floor input when briefDeliveryMinutes is null (window = 6.5h cap gap)", async () => {
    arrange({ settings: { ...settings, briefDeliveryMinutes: null } });
    await deliverDueBriefs();
    const args = mocks.eventsList.mock.calls[0][0];
    const windowMs =
      new Date(args.timeMax).getTime() - new Date(args.timeMin).getTime();
    // 1h recovery lookback + max(30, 390) = the 6.5h cron-gap lookahead
    expect(windowMs).toBe((60 + 6 * 60 + 30) * 60 * 1000);
  });

  it("warns when the calendar reports more events beyond the 25-event cap (nextPageToken)", async () => {
    const events = Array.from({ length: 25 }, () =>
      makeEvent({ attendees: [{ email: "stranger@nowhere.com" }] })
    );
    arrange({ events });
    mocks.eventsList.mockResolvedValue({
      data: { items: events, nextPageToken: "next-page" },
    });
    const result = await deliverDueBriefs();
    expect(result.status).toBe("completed");
    expect(result.skipped).toBe(25);
    expect(result.errors).toEqual([
      "coach coach@cocreate.com: calendar window exceeded the 25-event cap — later sessions in the window may be missing briefs",
    ]);
  });

  it("does not warn when a page is exactly at the cap with no further pages", async () => {
    const events = Array.from({ length: 25 }, () =>
      makeEvent({ attendees: [{ email: "stranger@nowhere.com" }] })
    );
    arrange({ events });
    const result = await deliverDueBriefs();
    expect(result.errors).toEqual([]);
  });

  it("stops generating when the shared time budget is exhausted and reports the deferral", async () => {
    const startISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    arrange({
      events: [
        makeEvent({ startISO, attendees: [{ email: clientA.email }] }),
        makeEvent({ startISO, attendees: [{ email: clientA.email }] }),
      ],
    });
    // Date.now() call order: startedAt, the outer per-coach budget check, then
    // one budget check per event. Let the first event through and the second
    // land past the 240s budget. (Events were built above, before the spy.)
    const nowValues = [1_000, 1_000, 1_000, 1_000 + 240_001];
    vi.spyOn(Date, "now").mockImplementation(
      () => nowValues.shift() ?? 1_000 + 240_001
    );

    const result = await deliverDueBriefs();
    expect(result.generated).toBe(1);
    expect(mocks.generatePrepBrief).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([
      "time budget exhausted after 1 briefs — sessions starting before the next run need the manual Generate Brief button; later ones are picked up next run",
    ]);
  });
});
