import { prisma } from "@/lib/db";
import Link from "next/link";
import { CoachingCalendar } from "@/components/coaching-calendar";

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

  // Check if calendar is configured
  let calendarConfigured = false;
  try {
    const settings = await prisma.coachSettings.findFirst();
    const { hasCalendarCredentials } = await import("@/lib/google-calendar");
    calendarConfigured = !!(settings?.googleCalendarId && hasCalendarCredentials());
  } catch {
    // Calendar not available
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

      {/* Coaching Schedule */}
      {calendarConfigured && <CoachingCalendar />}

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
