import { prisma } from "@/lib/db";
import Link from "next/link";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, viaClientWhere } from "@/lib/authz";
import { coachesForFilter } from "@/lib/coaches";
import { CoachFilter } from "@/components/coach-filter";

export const dynamic = "force-dynamic";

// The practice-wide session feed can be long; cap it and say so rather than
// silently paginating away older meetings.
const PAGE_SIZE = 100;

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ coach?: string }>;
}) {
  const coach = await requireCoachPage();
  const params = await searchParams;
  const coachId = scopeCoachId(coach, params.coach ?? null);

  const [sessions, total, coaches] = await Promise.all([
    prisma.session.findMany({
      where: viaClientWhere(coachId),
      orderBy: { date: "desc" },
      take: PAGE_SIZE,
      include: {
        client: { select: { id: true, name: true, coach: { select: { name: true } } } },
      },
    }),
    prisma.session.count({ where: viaClientWhere(coachId) }),
    coachesForFilter(coach),
  ]);

  // Column keys off role (attribution survives an inactive coach's history);
  // filter keys off the active roster (no point with one selectable coach).
  const isAdmin = coach.role !== "COACH";
  const showCoachControls = isAdmin && coaches.length > 1;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8 gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Meetings</h1>
          <p className="text-sm text-muted mt-1">
            {total} session{total === 1 ? "" : "s"}
            {total > PAGE_SIZE ? ` · showing the latest ${PAGE_SIZE}` : ""}
          </p>
        </div>
      </div>

      {showCoachControls && (
        <div className="mb-4">
          <CoachFilter coaches={coaches} selected={params.coach ?? null} basePath="/meetings" />
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <h2 className="font-display text-xl text-foreground">No meetings yet</h2>
          <p className="text-sm text-muted mt-2 max-w-md mx-auto leading-relaxed">
            Sessions appear here as Fathom recordings arrive and calendar events sync. Nothing
            has been captured for this view yet.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Date</Th>
                <Th>Client</Th>
                {isAdmin && <Th className="hidden md:table-cell">Coach</Th>}
                <Th className="hidden md:table-cell">Title</Th>
                <Th className="hidden sm:table-cell">Source</Th>
                <Th className="text-right">Duration</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className="border-b border-border last:border-b-0 hover:bg-background transition-colors"
                >
                  <td className="px-5 py-4 font-mono text-sm text-accent whitespace-nowrap">
                    {new Date(session.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td className="px-5 py-4">
                    <Link
                      href={`/clients/${session.client.id}`}
                      className="text-sm font-medium text-foreground hover:text-accent transition-colors"
                    >
                      {session.client.name}
                    </Link>
                    <p className="text-xs text-muted mt-0.5 md:hidden truncate">
                      {isAdmin ? `${session.client.coach?.name ?? "—"} · ` : ""}
                      {session.title}
                    </p>
                  </td>
                  {isAdmin && (
                    <td className="px-5 py-4 text-sm text-muted hidden md:table-cell">
                      {session.client.coach?.name ?? "—"}
                    </td>
                  )}
                  <td className="px-5 py-4 text-sm text-muted hidden md:table-cell max-w-xs truncate">
                    {session.title}
                  </td>
                  <td className="px-5 py-4 hidden sm:table-cell">
                    <SourceBadge source={session.sessionSource} />
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-sm text-muted whitespace-nowrap">
                    {session.durationMinutes} min
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium ${className}`}
    >
      {children}
    </th>
  );
}

function SourceBadge({ source }: { source: string }) {
  const styles: Record<string, string> = {
    FATHOM: "bg-accent-light text-accent border-accent/25",
    CALENDAR: "bg-info/10 text-info border-info/25",
    MANUAL: "bg-muted/10 text-muted border-border",
  };
  const label = source.charAt(0) + source.slice(1).toLowerCase();
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${
        styles[source] || styles.MANUAL
      }`}
    >
      {label}
    </span>
  );
}
