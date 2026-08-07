import { describe, it, expect, vi } from "vitest";

// google-calendar imports @/lib/db at module load (constructs PrismaClient).
// Stub it so this pure-function test needs no database.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { filterScheduleEvents } from "@/lib/google-calendar";
import type { calendar_v3 } from "googleapis";

function ev(
  summary: string,
  attendeeEmails: string[] = []
): calendar_v3.Schema$Event {
  return {
    id: summary,
    summary,
    attendees: attendeeEmails.map((email) => ({ email })),
    start: { dateTime: "2026-08-03T14:30:00-05:00" },
  };
}

const coachEmails = new Set(["kurt@growwithcocreate.com"]);
const clientEmails = new Set(["brodeurkai@gmail.com", "jfishivylane@gmail.com"]);

describe("filterScheduleEvents (calendar display)", () => {
  it("shows events whose title matches the coaching filter", () => {
    const events = [ev("Executive Coaching: Kai & Kurt", ["brodeurkai@gmail.com"])];
    const shown = filterScheduleEvents(events, null, coachEmails, clientEmails);
    expect(shown.map((e) => e.summary)).toEqual(["Executive Coaching: Kai & Kurt"]);
  });

  it("shows a plainly-titled event when a known client is on the invite (the Kurt bug)", () => {
    // Titled without any keyword, but Kai is Kurt's client. Title-only matching
    // silently dropped this — the reported "appointment not showing up".
    const events = [ev("Kai x Kurt", ["brodeurkai@gmail.com"])];
    const shown = filterScheduleEvents(events, null, coachEmails, clientEmails);
    expect(shown.map((e) => e.summary)).toEqual(["Kai x Kurt"]);
  });

  it("hides personal/internal events with no client and no keyword", () => {
    const events = [
      ev("Soccer"),
      ev("Meditation / Healing"),
      ev("Co-Create L10", ["kurt@growwithcocreate.com"]),
    ];
    const shown = filterScheduleEvents(events, null, coachEmails, clientEmails);
    expect(shown).toEqual([]);
  });

  it("does not match the coach's own address as a client attendee", () => {
    const events = [ev("Internal block", ["kurt@growwithcocreate.com"])];
    const shown = filterScheduleEvents(events, null, coachEmails, clientEmails);
    expect(shown).toEqual([]);
  });

  it("keeps a client-attended non-coaching meeting on the schedule (display-only, never billed)", () => {
    const events = [ev("Affordable Housing Project Meeting", ["brodeurkai@gmail.com"])];
    const shown = filterScheduleEvents(events, null, coachEmails, clientEmails);
    expect(shown.map((e) => e.summary)).toEqual(["Affordable Housing Project Meeting"]);
  });

  it("mixed calendar: keeps real sessions + client meetings, drops noise", () => {
    const events = [
      ev("Co-Create L10"),
      ev("Melissa x Kurt"), // no known client attendee -> hidden
      ev("Kurt | Joel - level-up plan", ["joel@sparrowhawkadvisors.com"]), // Joel not a client -> hidden
      ev("Executive Coaching: Kai & Kurt", ["brodeurkai@gmail.com"]), // title -> shown
      ev("Kai x Kurt", ["brodeurkai@gmail.com"]), // client -> shown
      ev("Soccer"),
    ];
    const shown = filterScheduleEvents(events, null, coachEmails, clientEmails).map((e) => e.summary);
    expect(shown).toEqual(["Executive Coaching: Kai & Kurt", "Kai x Kurt"]);
  });
});
