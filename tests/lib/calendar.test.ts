import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * listUpcomingMeetings (shared by the MCP get_upcoming_meetings tool). Exercises
 * the not-configured guard and the client-matching, mocking the Google Calendar
 * layer and the DB — no network.
 */

const m = vi.hoisted(() => ({
  settingsFindFirst: vi.fn(),
  coachFindUnique: vi.fn(),
  clientFindMany: vi.fn(),
  getUpcomingEvents: vi.fn(),
  hasCalendarCredentials: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachSettings: { findFirst: m.settingsFindFirst },
    coach: { findUnique: m.coachFindUnique },
    client: { findMany: m.clientFindMany },
  },
}));

vi.mock("@/lib/google-calendar", async (orig) => ({
  // Keep the real filter + duration helpers; only stub the network + creds.
  ...(await orig<typeof import("@/lib/google-calendar")>()),
  getUpcomingEvents: m.getUpcomingEvents,
  hasCalendarCredentials: m.hasCalendarCredentials,
}));

import { listUpcomingMeetings } from "@/lib/calendar";

const COACH = {
  coachingTitleFilter: "coaching|session",
  googleCalendarId: "cal-kurt",
  calendarSyncEnabled: true,
  defaultHourlyRate: null,
  loginEmail: "kurt@cocreate.com",
  workEmails: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.settingsFindFirst.mockResolvedValue(null);
  m.hasCalendarCredentials.mockReturnValue(true);
  m.coachFindUnique.mockResolvedValue(COACH);
  m.clientFindMany.mockResolvedValue([]);
  m.getUpcomingEvents.mockResolvedValue([]);
});

describe("listUpcomingMeetings", () => {
  it("returns no_calendar when the coach has no Google Calendar connected", async () => {
    m.coachFindUnique.mockResolvedValue({ ...COACH, googleCalendarId: null });
    const r = await listUpcomingMeetings("coach-kurt", 168);
    expect(r).toEqual({ status: "no_calendar" });
  });

  it("returns no_calendar when service-account credentials are absent", async () => {
    m.hasCalendarCredentials.mockReturnValue(false);
    const r = await listUpcomingMeetings("coach-kurt", 168);
    expect(r).toEqual({ status: "no_calendar" });
  });

  it("matches a known client on the invite and excludes the coach's own address", async () => {
    m.clientFindMany.mockResolvedValue([
      { id: "c1", name: "Ada Lovelace", email: "ada@acme.com", secondaryEmails: [], company: "Acme" },
    ]);
    m.getUpcomingEvents.mockResolvedValue([
      {
        summary: "Coaching — Ada",
        start: { dateTime: "2026-08-20T15:00:00-05:00" },
        end: { dateTime: "2026-08-20T16:00:00-05:00" },
        attendees: [{ email: "kurt@cocreate.com" }, { email: "ada@acme.com" }],
      },
    ]);

    const r = await listUpcomingMeetings("coach-kurt", 168);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.count).toBe(1);
    expect(r.meetings[0].client).toMatchObject({ id: "c1", name: "Ada Lovelace" });
    // The coach's own address is not listed as an "other" attendee.
    expect(r.meetings[0].otherAttendees).toEqual(["ada@acme.com"]);
    expect(r.meetings[0].durationMinutes).toBe(60);
  });

  it("includes a coaching-titled event even with no matched client (client null)", async () => {
    m.getUpcomingEvents.mockResolvedValue([
      {
        summary: "Executive coaching session",
        start: { dateTime: "2026-08-21T09:00:00-05:00" },
        end: { dateTime: "2026-08-21T10:00:00-05:00" },
        attendees: [{ email: "someone@stranger.com" }],
      },
    ]);
    const r = await listUpcomingMeetings("coach-kurt", 168);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.count).toBe(1);
    expect(r.meetings[0].client).toBeNull();
  });
});
