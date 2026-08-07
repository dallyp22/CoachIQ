import { prisma } from "@/lib/db";
import { getCalendar, DEFAULT_COACHING_FILTER } from "@/lib/google-calendar";

/**
 * Owner-facing practice views. Everything here reads across ALL coaches, so it
 * is only ever rendered behind requireCoachPage("ADMIN"). A COACH must never
 * reach it — these numbers are the whole practice, not one book.
 */

export type CoachOverviewRow = {
  coachId: string;
  name: string;
  activeClients: number;
  sessionsThisWeek: number;
  hoursThisMonth: number;
  unbilled: number;
};

/**
 * Per-coach performance leaderboard: active clients, sessions this week, hours
 * this month, unbilled dollars. One small set of aggregates per coach — the
 * practice has a handful of coaches, so a per-coach fan-out is cheaper to read
 * than a relation groupBy Prisma can't express directly.
 */
export async function getPracticeOverview(): Promise<CoachOverviewRow[]> {
  const coaches = await prisma.coach.findMany({
    where: { status: { not: "INACTIVE" } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return Promise.all(
    coaches.map(async (c) => {
      const via = { client: { coachId: c.id } };
      const [activeClients, sessionsThisWeek, monthSessions, unbilledEntries] =
        await Promise.all([
          prisma.client.count({ where: { coachId: c.id, status: "ACTIVE" } }),
          prisma.session.count({ where: { date: { gte: startOfWeek }, ...via } }),
          prisma.session.findMany({
            where: { date: { gte: startOfMonth }, ...via },
            select: { billableMinutes: true },
          }),
          prisma.timeEntry.findMany({
            where: { status: "UNBILLED", ...via },
            select: { amount: true },
          }),
        ]);

      return {
        coachId: c.id,
        name: c.name,
        activeClients,
        sessionsThisWeek,
        hoursThisMonth: monthSessions.reduce((s, x) => s + x.billableMinutes / 60, 0),
        unbilled: unbilledEntries.reduce((s, e) => s + Number(e.amount), 0),
      };
    })
  );
}

export type CoachCalendarHealth = {
  coachId: string;
  name: string;
  calendarId: string | null;
  configured: boolean;
  syncEnabled: boolean;
  /** Live probe: can the service account actually read this calendar? null when not configured. */
  reachable: boolean | null;
  reachError: string | null;
  titleFilter: string;
  /** Most recent session linked to a calendar event — the proxy for "sync is producing sessions". */
  lastCalendarSessionAt: Date | null;
};

/**
 * Per-coach calendar/sync health. Answers "why aren't a coach's appointments
 * showing up" without a support round-trip: is a calendar connected, is sync
 * on, and — the #1 real cause — has the calendar actually been shared with the
 * service account (a live read probe).
 *
 * The probe hits the Google API once per configured coach. The practice has few
 * coaches and this page loads on demand, so that cost is fine; each probe is
 * isolated so one unreachable calendar never blanks the whole panel.
 */
export async function getCoachCalendarHealth(): Promise<CoachCalendarHealth[]> {
  const coaches = await prisma.coach.findMany({
    where: { status: { not: "INACTIVE" } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      googleCalendarId: true,
      calendarSyncEnabled: true,
      coachingTitleFilter: true,
    },
  });

  const settings = await prisma.coachSettings.findFirst({
    select: { coachingTitleFilter: true },
  });

  return Promise.all(
    coaches.map(async (c) => {
      const calendarId = c.googleCalendarId;
      const titleFilter =
        c.coachingTitleFilter?.trim() ||
        settings?.coachingTitleFilter?.trim() ||
        DEFAULT_COACHING_FILTER;

      let reachable: boolean | null = null;
      let reachError: string | null = null;
      if (calendarId) {
        try {
          await getCalendar().calendars.get({ calendarId });
          reachable = true;
        } catch (err) {
          reachable = false;
          reachError =
            err instanceof Error
              ? // Google's messages are verbose; keep the first line.
                err.message.split("\n")[0]
              : "Unknown error";
        }
      }

      const lastLinked = await prisma.session.findFirst({
        where: { client: { coachId: c.id }, calendarEventId: { not: null } },
        orderBy: { date: "desc" },
        select: { date: true },
      });

      return {
        coachId: c.id,
        name: c.name,
        calendarId,
        configured: !!calendarId,
        syncEnabled: c.calendarSyncEnabled,
        reachable,
        reachError,
        titleFilter,
        lastCalendarSessionAt: lastLinked?.date ?? null,
      };
    })
  );
}
