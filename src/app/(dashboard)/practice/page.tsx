import Link from "next/link";
import { requireCoachPage } from "@/lib/authz-page";
import { getPracticeOverview, getCoachCalendarHealth } from "@/lib/practice-stats";

export const dynamic = "force-dynamic";

/**
 * Owner cockpit. Two questions an owner asks that no per-coach view answers:
 *   1. How is each coach doing? (overview leaderboard)
 *   2. Is each coach's calendar actually wired up? (setup health)
 *
 * ADMIN-gated: a COACH redirected here by a stray link lands on /no-access
 * rather than seeing the whole practice's numbers.
 */
export default async function PracticePage() {
  await requireCoachPage("ADMIN");

  const [overview, health] = await Promise.all([
    getPracticeOverview(),
    getCoachCalendarHealth(),
  ]);

  return (
    <div>
      <h1 className="font-display text-[32px] text-foreground">Practice</h1>
      <p className="text-sm text-muted mt-1">
        Every coach&apos;s numbers and calendar status, in one place.
      </p>

      {/* ── Overview leaderboard ─────────────────────────── */}
      <section className="mt-8">
        <h2 className="font-display text-[22px] text-foreground">Overview</h2>
        <div className="mt-4 bg-surface border border-border rounded-[var(--radius-lg)] overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-border">
                <Th>Coach</Th>
                <Th className="text-right">Active Clients</Th>
                <Th className="text-right">Sessions (Week)</Th>
                <Th className="text-right">Hours (Month)</Th>
                <Th className="text-right">Unbilled</Th>
              </tr>
            </thead>
            <tbody>
              {overview.map((row) => (
                <tr key={row.coachId} className="border-b border-border last:border-b-0 hover:bg-background transition-colors">
                  <td className="px-5 py-4">
                    {/* Jump straight to this coach's live schedule (view-as-coach). */}
                    <Link href={`/?coach=${row.coachId}`} className="text-sm font-medium text-foreground hover:text-accent transition-colors">
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-sm text-foreground">{row.activeClients}</td>
                  <td className="px-5 py-4 text-right font-mono text-sm text-foreground">{row.sessionsThisWeek}</td>
                  <td className="px-5 py-4 text-right font-mono text-sm text-foreground">{row.hoursThisMonth.toFixed(1)}</td>
                  <td className="px-5 py-4 text-right font-mono text-sm text-accent">
                    ${row.unbilled.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Calendar setup health ────────────────────────── */}
      <section className="mt-10">
        <h2 className="font-display text-[22px] text-foreground">Calendar Health</h2>
        <p className="text-sm text-muted mt-1">
          If a coach&apos;s appointments aren&apos;t showing up, start here. An unreachable
          calendar usually means it hasn&apos;t been shared with the CoachIQ service account.
        </p>
        <div className="mt-4 bg-surface border border-border rounded-[var(--radius-lg)] overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-border">
                <Th>Coach</Th>
                <Th>Connected</Th>
                <Th>Sync</Th>
                <Th>Reachable</Th>
                <Th>Last Synced</Th>
                <Th>Title Filter</Th>
              </tr>
            </thead>
            <tbody>
              {health.map((row) => (
                <tr key={row.coachId} className="border-b border-border last:border-b-0 align-top">
                  <td className="px-5 py-4 text-sm font-medium text-foreground whitespace-nowrap">{row.name}</td>
                  <td className="px-5 py-4">
                    {row.configured ? <Pill ok label="Connected" /> : <Pill label="Not set" />}
                  </td>
                  <td className="px-5 py-4">
                    {row.syncEnabled ? <Pill ok label="On" /> : <Pill label="Off" />}
                  </td>
                  <td className="px-5 py-4">
                    {row.reachable === null ? (
                      <span className="text-xs text-muted">—</span>
                    ) : row.reachable ? (
                      <Pill ok label="Yes" />
                    ) : (
                      <div>
                        <Pill bad label="No" />
                        {row.reachError && (
                          <p className="mt-1 text-[11px] text-error/90 font-mono max-w-[220px] break-words">
                            {row.reachError}
                          </p>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted whitespace-nowrap">
                    {row.lastCalendarSessionAt
                      ? new Date(row.lastCalendarSessionAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                      : "never"}
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted max-w-[200px] truncate" title={row.titleFilter}>
                    {row.titleFilter}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium ${className}`}>
      {children}
    </th>
  );
}

function Pill({ label, ok, bad }: { label: string; ok?: boolean; bad?: boolean }) {
  const style = ok
    ? "bg-success/10 text-success border-success/25"
    : bad
      ? "bg-error/10 text-error border-error/25"
      : "bg-muted/10 text-muted border-border";
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${style}`}>
      {label}
    </span>
  );
}
