import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, prospectWhere } from "@/lib/authz";
import { liveStages } from "@/lib/pipeline/stages";
import { buildPipelineSummary, formatDays, type ProspectRow } from "@/lib/pipeline/report-math";

export const dynamic = "force-dynamic";

/**
 * Pipeline reports (PRD §7).
 *
 * Every statistic here is a mean, and on an empty pipeline every one is
 * undefined. The arithmetic lives in report-math.ts as pure functions that
 * return null — rendered as an em-dash, never 0. "0 days in stage" claims
 * nothing is sitting; the truth is nothing is there.
 */
export default async function PipelineReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ coach?: string }>;
}) {
  const coach = await requireCoachPage();
  const params = await searchParams;
  const coachId = scopeCoachId(coach, params.coach ?? null);

  const stages = await liveStages();
  const openStages = stages.filter((s) => s.terminal === null);

  const openProspects = await prisma.prospect.findMany({
    where: { ...prospectWhere(coachId), stage: { terminal: null } },
    select: {
      id: true,
      stageId: true,
      createdAt: true,
      stageEnteredAt: true,
      firstName: true,
      lastName: true,
      company: true,
      opportunityType: true,
      nextActivityAt: true,
      stage: { select: { id: true, name: true, isHot: true } },
      assignedCoach: { select: { name: true } },
    },
  });

  const lastActivity = await prisma.pipelineActivity.groupBy({
    by: ["prospectId"],
    where: {
      prospectId: { in: openProspects.map((p) => p.id) },
      OR: [{ kind: "LOGGED" }, { completedAt: { not: null } }],
    },
    _max: { activityAt: true },
  });
  const lastByProspect = new Map(lastActivity.map((l) => [l.prospectId, l._max.activityAt ?? null]));

  const rows: ProspectRow[] = openProspects.map((p) => ({
    id: p.id,
    stageId: p.stageId,
    createdAt: p.createdAt,
    stageEnteredAt: p.stageEnteredAt,
    lastActivityAt: lastByProspect.get(p.id) ?? null,
  }));

  const summary = buildPipelineSummary(rows, openStages, new Date());
  const hot = openProspects.filter((p) => p.stage.isHot);
  const peak = Math.max(1, ...summary.byStage.map((s) => s.count));

  return (
    <div>
      <Link
        href="/pipeline"
        className="text-sm text-muted hover:text-foreground transition-colors inline-flex items-center gap-1.5 mb-4"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
        </svg>
        Pipeline
      </Link>

      <h1 className="font-display text-[32px] text-foreground mb-1">Pipeline reports</h1>
      <p className="text-sm text-muted mb-8">
        {summary.totalOpen} open prospect{summary.totalOpen === 1 ? "" : "s"}
      </p>

      {/* ─── Headline averages ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <Stat label="Average age on list" value={formatDays(summary.averageAgeDays)} />
        <Stat label="Average time in stage" value={formatDays(summary.averageTimeInStageDays)} />
        <Stat
          label="Average since last activity"
          value={formatDays(summary.averageDaysSinceLastActivity)}
          hint="Prospects with no activity count from the day they were added."
        />
      </div>

      {/* ─── By stage ─── */}
      <section className="mb-8">
        <h2 className="font-display text-xl text-foreground mb-3">By stage</h2>
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
          {summary.byStage.length === 0 ? (
            <p className="text-sm text-muted">No open stages configured.</p>
          ) : (
            <div className="space-y-3">
              {summary.byStage.map((s) => (
                <div key={s.stageId} className="grid grid-cols-[minmax(0,150px)_1fr_auto] gap-3 items-center">
                  <Link
                    href={`/pipeline?stage=${s.stageId}`}
                    className="text-sm text-foreground hover:text-accent transition-colors truncate"
                  >
                    {s.name}
                  </Link>
                  <div className="h-5 bg-background rounded-sm overflow-hidden">
                    {s.count > 0 && (
                      <div
                        className="h-full bg-accent/70 rounded-sm"
                        style={{ width: `${(s.count / peak) * 100}%` }}
                      />
                    )}
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <span className="font-mono text-sm text-foreground tabular-nums">{s.count}</span>
                    <span className="font-mono text-xs text-muted ml-2 tabular-nums">
                      {formatDays(s.averageDaysSinceLastActivity)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted mt-4 pt-3 border-t border-border">
            Count, then average days since last activity in that stage. An em-dash means no
            prospects there — not zero days.
          </p>
        </div>
      </section>

      {/* ─── Hot prospects ─── */}
      <section>
        <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
          <h2 className="font-display text-xl text-foreground">Hot prospects</h2>
          <p className="text-xs text-muted">
            Stages flagged hot in{" "}
            <Link href="/settings" className="text-accent hover:text-accent-hover">
              Settings
            </Link>
          </p>
        </div>

        {hot.length === 0 ? (
          <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-8 text-center">
            <p className="text-sm text-muted">
              Nothing in a hot stage right now.
            </p>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-[var(--radius-lg)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <Th>Name</Th>
                    <Th className="hidden sm:table-cell">Company</Th>
                    <Th className="hidden md:table-cell">Opportunity</Th>
                    <Th>Stage</Th>
                    <Th>Next</Th>
                    <Th className="hidden lg:table-cell">Coach</Th>
                  </tr>
                </thead>
                <tbody>
                  {hot.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-b-0 hover:bg-background transition-colors"
                    >
                      <td className="px-5 py-3">
                        <Link
                          href={`/pipeline/${p.id}`}
                          className="font-display text-base text-foreground hover:text-accent transition-colors"
                        >
                          {`${p.firstName} ${p.lastName}`.trim()}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-sm text-muted hidden sm:table-cell">
                        {p.company || "—"}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted hidden md:table-cell">
                        {p.opportunityType.charAt(0) + p.opportunityType.slice(1).toLowerCase()}
                      </td>
                      <td className="px-5 py-3">
                        <span className="inline-block px-2 py-0.5 text-xs font-medium rounded border bg-accent-light text-accent border-accent/25 whitespace-nowrap">
                          {p.stage.name}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {p.nextActivityAt ? (
                          <span className="font-mono text-sm text-foreground whitespace-nowrap">
                            {new Date(p.nextActivityAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        ) : (
                          <span className="text-sm text-error whitespace-nowrap">None scheduled</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted hidden lg:table-cell">
                        {p.assignedCoach?.name ?? "Unassigned"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
      <p className="text-xs text-muted uppercase tracking-wide font-medium">{label}</p>
      <p className="font-mono text-[28px] text-foreground mt-2 tabular-nums leading-none">{value}</p>
      {hint && <p className="text-[11px] text-muted mt-2 leading-snug">{hint}</p>}
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium ${className}`}
    >
      {children}
    </th>
  );
}
