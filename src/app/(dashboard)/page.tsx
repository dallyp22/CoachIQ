import { prisma } from "@/lib/db";
import Link from "next/link";
import { MorningBriefButton } from "@/components/morning-brief-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const now = new Date();
  const greeting =
    now.getHours() < 12
      ? "Good morning"
      : now.getHours() < 17
        ? "Good afternoon"
        : "Good evening";

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Query real stats
  const activeClients = await prisma.client.count({
    where: { status: "ACTIVE" },
  });

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const sessionsThisWeek = await prisma.session.count({
    where: { date: { gte: startOfWeek } },
  });

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthSessions = await prisma.session.findMany({
    where: { date: { gte: startOfMonth } },
    select: { billableMinutes: true },
  });

  const hoursThisMonth = monthSessions.reduce(
    (sum, s) => sum + s.billableMinutes / 60,
    0
  );

  // Billing stats
  const unbilledEntries = await prisma.timeEntry.findMany({
    where: { status: "UNBILLED" },
  });
  const unbilledAmount = unbilledEntries.reduce(
    (sum, e) => sum + Number(e.amount),
    0
  );

  // Today's coaching from Google Calendar
  let todayEvents: Array<{
    eventId: string;
    title: string;
    start: string;
    end: string;
    durationMinutes: number;
    client: { id: string; name: string; company: string | null } | null;
    lastSynopsis: string | null;
    hasBrief: boolean;
  }> = [];
  let calendarConfigured = false;

  try {
    const settings = await prisma.coachSettings.findFirst();
    const { hasCalendarCredentials } = await import("@/lib/google-calendar");
    if (settings?.googleCalendarId && hasCalendarCredentials()) {
      calendarConfigured = true;
      const { getCalendar, filterCoachingEvents, eventDurationMinutes } = await import("@/lib/google-calendar");

      const today = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const timeMin = new Date(`${today}T00:00:00`);
      const timeMax = new Date(`${today}T23:59:59`);

      const calendar = getCalendar();
      const res = await calendar.events.list({
        calendarId: settings.googleCalendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 20,
      });

      const rawEvents = res.data.items || [];
      const coachingEvents = filterCoachingEvents(rawEvents, settings.coachingTitleFilter);

      // Load clients for matching
      const clients = await prisma.client.findMany({
        where: { status: { not: "CHURNED" } },
        select: { id: true, name: true, email: true, secondaryEmails: true, company: true },
      });
      const emailToClient = new Map<string, (typeof clients)[number]>();
      for (const c of clients) {
        emailToClient.set(c.email.toLowerCase(), c);
        for (const se of c.secondaryEmails) emailToClient.set(se.toLowerCase(), c);
      }

      const coachEmail = settings.coachEmail?.toLowerCase() || "";

      for (const event of coachingEvents) {
        const attendees = event.attendees
          ?.filter((a) => a.email && a.email.toLowerCase() !== coachEmail && !a.resource)
          .map((a) => a.email!.toLowerCase()) ?? [];

        let matchedClient: (typeof clients)[number] | null = null;
        for (const email of attendees) {
          const c = emailToClient.get(email);
          if (c) { matchedClient = c; break; }
        }

        // Get last session synopsis for context
        let lastSynopsis: string | null = null;
        if (matchedClient) {
          const lastSession = await prisma.session.findFirst({
            where: { clientId: matchedClient.id, synopsis: { not: null } },
            orderBy: { date: "desc" },
            select: { synopsis: true },
          });
          if (lastSession?.synopsis) {
            // First sentence only
            const firstSentence = lastSession.synopsis.split(/[.!?]\s/)[0];
            lastSynopsis = firstSentence.length < 150 ? firstSentence + "." : firstSentence.slice(0, 147) + "...";
          }
        }

        // Check for existing prep brief
        let hasBrief = false;
        if (matchedClient) {
          const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : null;
          if (eventStart) {
            const hourBefore = new Date(eventStart.getTime() - 60 * 60 * 1000);
            const hourAfter = new Date(eventStart.getTime() + 60 * 60 * 1000);
            const brief = await prisma.prepBrief.findFirst({
              where: {
                clientId: matchedClient.id,
                targetSessionDate: { gte: hourBefore, lte: hourAfter },
              },
              select: { id: true },
            });
            hasBrief = !!brief;
          }
        }

        todayEvents.push({
          eventId: event.id || "",
          title: event.summary || "Coaching Session",
          start: event.start?.dateTime || event.start?.date || "",
          end: event.end?.dateTime || event.end?.date || "",
          durationMinutes: eventDurationMinutes(event),
          client: matchedClient ? { id: matchedClient.id, name: matchedClient.name, company: matchedClient.company } : null,
          lastSynopsis,
          hasBrief,
        });
      }
    }
  } catch {
    // Calendar not configured or inaccessible — silently skip
  }

  // Recent sessions for the feed
  const recentSessions = await prisma.session.findMany({
    orderBy: { date: "desc" },
    take: 8,
    include: {
      client: { select: { name: true, id: true } },
    },
  });

  return (
    <div>
      <h1 className="font-display text-[32px] text-foreground">
        {greeting}, Todd
      </h1>
      <p className="font-mono text-sm text-muted mt-1">{dateStr}</p>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        <StatCard label="Active Clients" value={String(activeClients)} />
        <StatCard label="Sessions This Week" value={String(sessionsThisWeek)} />
        <StatCard
          label="Hours (Month)"
          value={hoursThisMonth.toFixed(1)}
        />
        <StatCard
          label="Unbilled"
          value={`$${unbilledAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          accent
        />
      </div>

      {/* Today's Coaching */}
      {calendarConfigured && (
        <div className="mt-10 border-t border-border pt-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[22px] text-foreground">
              Today&apos;s Coaching
            </h2>
            {todayEvents.length > 0 && <MorningBriefButton />}
          </div>
          {todayEvents.length === 0 ? (
            <p className="text-sm text-muted mt-3">
              No coaching sessions scheduled today.
            </p>
          ) : (
            <div className="mt-4 grid gap-3">
              {todayEvents.map((event) => {
                const startTime = event.start
                  ? new Date(event.start).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "America/Chicago",
                    })
                  : "";
                const endTime = event.end
                  ? new Date(event.end).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "America/Chicago",
                    })
                  : "";

                return (
                  <div
                    key={event.eventId}
                    className="bg-surface border border-border rounded-[var(--radius-md)] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-accent font-medium">
                            {startTime}
                          </span>
                          <span className="text-xs text-muted">–</span>
                          <span className="font-mono text-xs text-muted">
                            {endTime}
                          </span>
                        </div>
                        {event.client ? (
                          <Link
                            href={`/clients/${event.client.id}`}
                            className="text-sm font-medium text-foreground hover:text-accent transition-colors mt-1 block"
                          >
                            {event.client.name}
                            {event.client.company && (
                              <span className="text-muted font-normal">
                                {" "}
                                — {event.client.company}
                              </span>
                            )}
                          </Link>
                        ) : (
                          <p className="text-sm text-foreground mt-1">{event.title}</p>
                        )}
                        {event.lastSynopsis && (
                          <p className="text-xs text-muted mt-1.5 line-clamp-2 italic">
                            {event.lastSynopsis}
                          </p>
                        )}
                        {event.hasBrief && (
                          <span className="inline-block mt-1.5 text-[10px] font-mono uppercase tracking-wider text-success">
                            Brief ready
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-xs text-muted bg-background border border-border px-2 py-0.5 rounded shrink-0">
                        {event.durationMinutes} min
                      </span>
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-muted mt-1">
                {todayEvents.length} session{todayEvents.length !== 1 ? "s" : ""} &middot;{" "}
                {todayEvents.reduce((sum, e) => sum + Math.ceil(e.durationMinutes / 15) * 0.25, 0).toFixed(1)} expected billable hrs
              </p>
            </div>
          )}
        </div>
      )}

      {/* Recent Sessions */}
      <div className="mt-10 border-t border-border pt-6">
        <h2 className="font-display text-[22px] text-foreground">
          Recent Sessions
        </h2>
        <div className="mt-4">
          {recentSessions.length === 0 ? (
            <p className="text-sm text-muted">
              No sessions recorded yet.
            </p>
          ) : (
            <div className="space-y-0">
              {recentSessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center gap-4 py-3.5 border-b border-border last:border-b-0"
                >
                  <span className="font-mono text-sm text-accent min-w-[60px] font-medium">
                    {new Date(session.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/clients/${session.client.id}`}
                      className="text-sm font-medium text-foreground hover:text-accent transition-colors"
                    >
                      {session.client.name}
                    </Link>
                    <p className="text-xs text-muted truncate mt-0.5">
                      {session.title}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-muted">
                    {session.durationMinutes} min
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-surface border border-border rounded-[var(--radius-md)] p-5">
      <p className="text-xs text-muted uppercase tracking-wide font-medium">
        {label}
      </p>
      <p
        className={`font-mono text-[28px] font-medium mt-2 leading-none ${
          accent ? "text-accent" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
