import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, prospectWhere } from "@/lib/authz";
import { liveStages } from "@/lib/pipeline/stages";
import { buildPipelineSummary, formatDays, type ProspectRow } from "@/lib/pipeline/report-math";
import { activityDetailFor } from "@/lib/pipeline/next-activity";
import { CoachFilter } from "../coach-filter";

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

  // Joel's fields 7-9 and 11-12 need the notes and owner on BOTH activities,
  // not just their dates — the report is named after his spec, so it has to
  // carry his spec.
  const { last, next } = await activityDetailFor(prisma, openProspects.map((p) => p.id));
  const lastByProspect = new Map([...last].map(([id, d]) => [id, d.activityAt]));

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

  const allCoaches =
    coach.role === "COACH"
      ? []
      : await prisma.coach.findMany({
          where: { status: { not: "INACTIVE" } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        });

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
      <p className="text-sm text-muted mb-4">
        {summary.totalOpen} open prospect{summary.totalOpen === 1 ? "" : "s"}
      </p>

      {allCoaches.length > 1 && (
        <div className="mb-6">
          <CoachFilter coaches={allCoaches} selected={params.coach ?? null} basePath="/pipeline/reports" />
        </div>
      )}

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
                    <Th className="hidden xl:table-cell">Added</Th>
                    <Th>Last activity</Th>
                    <Th>Next activity</Th>
                  </tr>
                </thead>
                <tbody>
                  {hot.map((p) => {
                    const lastAct = last.get(p.id);
                    const nextAct = next.get(p.id);
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-border last:border-b-0 hover:bg-background transition-colors align-top"
                      >
                        <td className="px-5 py-3">
                          <Link
                            href={`/pipeline/${p.id}`}
                            className="font-display text-base text-foreground hover:text-accent transition-colors"
                          >
                            {`${p.firstName} ${p.lastName}`.trim()}
                          </Link>
                          <p className="text-xs text-muted mt-0.5">{p.stage.name}</p>
                        </td>
                        <td className="px-5 py-3 text-sm text-muted hidden sm:table-cell">
                          {p.company || "—"}
                        </td>
                        <td className="px-5 py-3 text-sm text-muted hidden md:table-cell">
                          {p.opportunityType.charAt(0) + p.opportunityType.slice(1).toLowerCase()}
                        </td>
                        <td className="px-5 py-3 font-mono text-sm text-muted hidden xl:table-cell whitespace-nowrap">
                          {fmt(p.createdAt)}
                        </td>
                        {/* Joel's fields 7-9: date, notes, owner */}
                        <td className="px-5 py-3 min-w-[180px]">
                          {lastAct ? (
                            <>
                              <span className="font-mono text-sm text-foreground whitespace-nowrap">
                                {fmt(lastAct.activityAt)}
                              </span>
                              <p className="text-xs text-muted mt-0.5">
                                {lastAct.owner?.name ?? "System"}
                              </p>
                              {lastAct.notes && (
                                <p className="text-xs text-foreground mt-1 leading-snug">
                                  {lastAct.notes}
                                </p>
                              )}
                            </>
                          ) : (
                            <span className="text-sm text-muted">Never contacted</span>
                          )}
                        </td>
                        {/* Joel's fields 10-12: date, notes, owner */}
                        <td className="px-5 py-3 min-w-[180px]">
                          {nextAct ? (
                            <>
                              <span className="font-mono text-sm text-foreground whitespace-nowrap">
                                {fmt(nextAct.activityAt)}
                              </span>
                              <p className="text-xs text-muted mt-0.5">
                                {nextAct.owner?.name ?? "System"}
                              </p>
                              {nextAct.notes && (
                                <p className="text-xs text-foreground mt-1 leading-snug">
                                  {nextAct.notes}
                                </p>
                              )}
                            </>
                          ) : (
                            <span className="text-sm text-error whitespace-nowrap">
                              None scheduled
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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

function fmt(d: Date) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
