import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  coachSettingsFindFirst: vi.fn(),
  coachFindMany: vi.fn(),
  clientFindMany: vi.fn(),
  sessionFindUnique: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionUpdate: vi.fn(),
  transaction: vi.fn(),
  txSessionCreate: vi.fn(),
  txSessionFindUnique: vi.fn(),
  txTimeEntryCreate: vi.fn(),
  txClientUpdate: vi.fn(),
  eventsList: vi.fn(),
  filterCoachingEvents: vi.fn(),
  eventDurationMinutes: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachSettings: { findFirst: mocks.coachSettingsFindFirst },
    coach: { findMany: mocks.coachFindMany },
    client: { findMany: mocks.clientFindMany },
    session: {
      findUnique: mocks.sessionFindUnique,
      findFirst: mocks.sessionFindFirst,
      update: mocks.sessionUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/google-calendar", () => ({
  getCalendar: () => ({ events: { list: mocks.eventsList } }),
  filterCoachingEvents: mocks.filterCoachingEvents,
  eventDurationMinutes: mocks.eventDurationMinutes,
}));

// resolveCoachConfig is the real one — these tests also verify per-coach
// calendar id, title filter, and email-set wiring.
import { syncCalendarSessions } from "@/lib/calendar-sync";

const settings = { coachingTitleFilter: "coaching", timezone: "America/Chicago", defaultHourlyRate: null };

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

const clientA = { id: "client-a", name: "Alice", email: "alice@example.com", secondaryEmails: [], hourlyRate: 200, allowsFathom: false };
const clientB = { id: "client-b", name: "Bob", email: "bob@example.com", secondaryEmails: [], hourlyRate: 300, allowsFathom: false };

// A past event (calendar-sync only creates sessions for past events).
function pastEvent(opts: { id?: string; attendees?: Array<{ email?: string; resource?: boolean }> }) {
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    id: opts.id ?? "evt-1",
    summary: "Coaching: session",
    attendees: opts.attendees,
    start: { dateTime: start },
    end: { dateTime: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
  };
}

function arrange(opts: {
  coaches?: unknown[];
  eventsByCalendar?: Record<string, unknown[]>;
  events?: unknown[];
  clientsByCoach?: Record<string, unknown[]>;
  clients?: unknown[];
  existingSession?: unknown;
  existingFathomSession?: unknown;
} = {}) {
  mocks.coachSettingsFindFirst.mockResolvedValue(settings);
  mocks.coachFindMany.mockResolvedValue(opts.coaches ?? [coachA]);
  if (opts.eventsByCalendar) {
    mocks.eventsList.mockImplementation(async ({ calendarId }: { calendarId: string }) => ({
      data: { items: opts.eventsByCalendar![calendarId] ?? [] },
    }));
  } else {
    mocks.eventsList.mockResolvedValue({ data: { items: opts.events ?? [] } });
  }
  mocks.filterCoachingEvents.mockImplementation((events: unknown[]) => events);
  if (opts.clientsByCoach) {
    mocks.clientFindMany.mockImplementation(async ({ where }: { where: { coachId: string } }) =>
      opts.clientsByCoach![where.coachId] ?? []
    );
  } else {
    mocks.clientFindMany.mockResolvedValue(opts.clients ?? [clientA]);
  }
  mocks.sessionFindUnique.mockResolvedValue(opts.existingSession ?? null);
  mocks.sessionFindFirst.mockResolvedValue(opts.existingFathomSession ?? null);
  mocks.eventDurationMinutes.mockReturnValue(60);
  // $transaction runs its callback with a tx object exposing the writes.
  mocks.txSessionCreate.mockResolvedValue({ id: "sess-new" });
  mocks.txSessionFindUnique.mockResolvedValue({ id: "sess-new" });
  mocks.txTimeEntryCreate.mockResolvedValue({ id: "te-new" });
  mocks.txClientUpdate.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      session: { create: mocks.txSessionCreate, findUnique: mocks.txSessionFindUnique },
      timeEntry: { create: mocks.txTimeEntryCreate },
      client: { update: mocks.txClientUpdate },
    })
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

const T0 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
const T1 = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe("syncCalendarSessions — coach selection", () => {
  it("does nothing when no coach has a calendar", async () => {
    arrange({ coaches: [] });
    const result = await syncCalendarSessions(T0, T1);
    expect(result).toEqual({ created: 0, linked: 0, skipped: 0, errors: [] });
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("skips a coach whose calendarSyncEnabled is false (no calendar fetch)", async () => {
    arrange({ coaches: [{ ...coachA, calendarSyncEnabled: false }] });
    await syncCalendarSessions(T0, T1);
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });
});

describe("syncCalendarSessions — multi-coach iteration and isolation", () => {
  it("fetches each coach's OWN calendar and scopes client-matching to that coach", async () => {
    arrange({
      coaches: [coachA, coachB],
      eventsByCalendar: {
        "cal-a": [pastEvent({ id: "evt-a", attendees: [{ email: clientA.email }] })],
        "cal-b": [pastEvent({ id: "evt-b", attendees: [{ email: clientB.email }] })],
      },
      clientsByCoach: { "coach-a": [clientA], "coach-b": [clientB] },
    });
    const result = await syncCalendarSessions(T0, T1);
    expect(result.created).toBe(2);

    const calendarIds = mocks.eventsList.mock.calls.map((c) => c[0].calendarId).sort();
    expect(calendarIds).toEqual(["cal-a", "cal-b"]);
    const coachIds = mocks.clientFindMany.mock.calls.map((c) => c[0].where.coachId).sort();
    expect(coachIds).toEqual(["coach-a", "coach-b"]);
  });

  it("does NOT create a session for another coach's client on this coach's calendar", async () => {
    // coachA's calendar has an event whose only attendee is coachB's client.
    // coachA's client query is scoped to coach-a, so there is no match and no
    // Session/TimeEntry is minted on client-b. This is the billable tenant boundary.
    arrange({
      coaches: [coachA],
      eventsByCalendar: { "cal-a": [pastEvent({ attendees: [{ email: clientB.email }] })] },
      clientsByCoach: { "coach-a": [clientA] },
    });
    const result = await syncCalendarSessions(T0, T1);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txSessionCreate).not.toHaveBeenCalled();
  });
});

describe("syncCalendarSessions — session creation", () => {
  it("creates a Session + UNBILLED TimeEntry for a past non-Fathom client event", async () => {
    arrange({
      coaches: [coachA],
      events: [pastEvent({ attendees: [{ email: clientA.email }] })],
      clients: [clientA],
    });
    const result = await syncCalendarSessions(T0, T1);
    expect(result.created).toBe(1);
    expect(mocks.txSessionCreate).toHaveBeenCalledTimes(1);
    const sessionData = mocks.txSessionCreate.mock.calls[0][0].data;
    expect(sessionData.clientId).toBe("client-a");
    expect(sessionData.sessionSource).toBe("CALENDAR");
    const teData = mocks.txTimeEntryCreate.mock.calls[0][0].data;
    expect(teData.clientId).toBe("client-a");
    expect(teData.status).toBe("UNBILLED");
  });

  it("excludes the coach's own emails from attendee matching", async () => {
    arrange({
      coaches: [{ ...coachA, workEmails: ["coach.alt@cocreate.com"] }],
      events: [
        pastEvent({
          attendees: [
            { email: coachA.loginEmail },
            { email: "coach.alt@cocreate.com" },
          ],
        }),
      ],
      clients: [clientA],
    });
    const result = await syncCalendarSessions(T0, T1);
    // Neither attendee is a client — coach's own addresses are excluded.
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.txSessionCreate).not.toHaveBeenCalled();
  });

  it("links a past event to an existing Fathom session instead of creating one", async () => {
    arrange({
      coaches: [coachA],
      events: [pastEvent({ attendees: [{ email: clientA.email }] })],
      clients: [{ ...clientA, allowsFathom: true }],
      existingFathomSession: { id: "fathom-sess-1" },
    });
    const result = await syncCalendarSessions(T0, T1);
    expect(result.linked).toBe(1);
    expect(result.created).toBe(0);
    expect(mocks.sessionUpdate).toHaveBeenCalledWith({
      where: { id: "fathom-sess-1" },
      data: { calendarEventId: "evt-1" },
    });
    expect(mocks.txSessionCreate).not.toHaveBeenCalled();
  });

  it("skips an event already linked to a session", async () => {
    arrange({
      coaches: [coachA],
      events: [pastEvent({ attendees: [{ email: clientA.email }] })],
      clients: [clientA],
      existingSession: { id: "already" },
    });
    const result = await syncCalendarSessions(T0, T1);
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("collects a per-coach error without aborting the whole run", async () => {
    // coachA's calendar throws; coachB still processes.
    mocks.coachSettingsFindFirst.mockResolvedValue(settings);
    mocks.coachFindMany.mockResolvedValue([coachA, coachB]);
    mocks.eventsList.mockImplementation(async ({ calendarId }: { calendarId: string }) => {
      if (calendarId === "cal-a") throw new Error("Google 500");
      return { data: { items: [pastEvent({ id: "evt-b", attendees: [{ email: clientB.email }] })] } };
    });
    mocks.filterCoachingEvents.mockImplementation((e: unknown[]) => e);
    mocks.clientFindMany.mockImplementation(async ({ where }: { where: { coachId: string } }) =>
      where.coachId === "coach-b" ? [clientB] : []
    );
    mocks.sessionFindUnique.mockResolvedValue(null);
    mocks.eventDurationMinutes.mockReturnValue(60);
    mocks.txSessionCreate.mockResolvedValue({ id: "s" });
    mocks.txSessionFindUnique.mockResolvedValue({ id: "s" });
    mocks.txTimeEntryCreate.mockResolvedValue({});
    mocks.txClientUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        session: { create: mocks.txSessionCreate, findUnique: mocks.txSessionFindUnique },
        timeEntry: { create: mocks.txTimeEntryCreate },
        client: { update: mocks.txClientUpdate },
      })
    );

    const result = await syncCalendarSessions(T0, T1);
    expect(result.created).toBe(1); // coachB still processed
    expect(result.errors).toEqual(["coach coach@cocreate.com: Google 500"]);
  });
});
