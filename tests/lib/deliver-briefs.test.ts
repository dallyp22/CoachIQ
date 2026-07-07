import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  coachSettingsFindFirst: vi.fn(),
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

import { deliverDueBriefs } from "@/lib/deliver-briefs";

const COACH_EMAIL = "coach@cocreate.com";

const baseSettings = {
  googleCalendarId: "cal-1",
  briefDeliveryMinutes: 30,
  coachingTitleFilter: "coaching",
  coachEmail: COACH_EMAIL,
};

const clientA = {
  id: "client-a",
  email: "alice@example.com",
  secondaryEmails: ["alice.work@corp.com"],
  sessionCount: 5,
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
  credentials?: boolean;
  events?: unknown[];
  clients?: unknown[];
  existingBrief?: unknown;
} = {}) {
  mocks.coachSettingsFindFirst.mockResolvedValue(
    "settings" in opts ? opts.settings : baseSettings
  );
  mocks.hasCalendarCredentials.mockReturnValue(opts.credentials ?? true);
  mocks.eventsList.mockResolvedValue({ data: { items: opts.events ?? [] } });
  // Pass-through by default so tests control the event set directly
  mocks.filterCoachingEvents.mockImplementation((events: unknown[]) => events);
  mocks.clientFindMany.mockResolvedValue(opts.clients ?? [clientA]);
  mocks.prepBriefFindFirst.mockResolvedValue(opts.existingBrief ?? null);
  mocks.generatePrepBrief.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deliverDueBriefs — configuration guards", () => {
  it("skips when no coach settings row exists", async () => {
    arrange({ settings: null });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "skipped", reason: "Calendar not configured" });
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("skips when googleCalendarId is not set", async () => {
    arrange({ settings: { ...baseSettings, googleCalendarId: null } });
    const result = await deliverDueBriefs();
    expect(result.status).toBe("skipped");
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("skips when calendar credentials are missing", async () => {
    arrange({ credentials: false });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "skipped", reason: "Calendar not configured" });
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });
});

describe("deliverDueBriefs — lookahead window", () => {
  it("floors the window at 6.5h when briefDeliveryMinutes is small", async () => {
    arrange({ settings: { ...baseSettings, briefDeliveryMinutes: 30 } });
    await deliverDueBriefs();
    const args = mocks.eventsList.mock.calls[0][0];
    const windowMs =
      new Date(args.timeMax).getTime() - new Date(args.timeMin).getTime();
    expect(windowMs).toBe((6 * 60 + 30) * 60 * 1000);
    expect(args.calendarId).toBe("cal-1");
  });

  it("uses briefDeliveryMinutes when it exceeds the 6.5h floor", async () => {
    arrange({ settings: { ...baseSettings, briefDeliveryMinutes: 600 } });
    // Also cover the missing-items fallback: Google can return data with no items
    mocks.eventsList.mockResolvedValue({ data: {} });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 0, failed: 0, errors: [] });
    const args = mocks.eventsList.mock.calls[0][0];
    const windowMs =
      new Date(args.timeMax).getTime() - new Date(args.timeMin).getTime();
    expect(windowMs).toBe(600 * 60 * 1000);
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

  it("skips matched clients with sessionCount 0 (no history to brief on)", async () => {
    arrange({
      clients: [{ ...clientA, sessionCount: 0 }],
      events: [makeEvent({ attendees: [{ email: clientA.email }] })],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 0, skipped: 1, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).not.toHaveBeenCalled();
  });

  it("matches a client via a secondary email (case-insensitive, coachEmail unset)", async () => {
    arrange({
      // coachEmail null exercises the `?.toLowerCase() || ""` fallback
      settings: { ...baseSettings, coachEmail: null },
      events: [makeEvent({ attendees: [{ email: "Alice.Work@Corp.com" }] })],
    });
    const result = await deliverDueBriefs();
    expect(result).toEqual({ status: "completed", generated: 1, skipped: 0, failed: 0, errors: [] });
    expect(mocks.generatePrepBrief).toHaveBeenCalledWith("client-a", expect.any(Date));
  });

  it("ignores the coach's own email and resource attendees when matching", async () => {
    arrange({
      // Coach uses same address as a client would — must be excluded; room resource too
      events: [
        makeEvent({
          attendees: [
            { email: COACH_EMAIL },
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
    const clientB = {
      id: "client-b",
      email: "bob@example.com",
      secondaryEmails: [],
      sessionCount: 3,
    };
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
});
