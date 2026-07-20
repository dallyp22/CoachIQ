import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, prospectWhere } from "@/lib/authz";
import { STALEST_FIRST } from "@/lib/pipeline/next-activity";
import { liveStages } from "@/lib/pipeline/stages";
import { AddProspectButton } from "./add-prospect";
import { NextActivityCell, DaysInStage } from "./cells";

export const dynamic = "force-dynamic";

/**
 * The pipeline list (PRD §6.2) — one row per prospect, stalest first.
 *
 * The ordering is the feature. Sorted by next activity ascending NULLS FIRST,
 * so the prospects nobody has scheduled anything for sit at the top, then the
 * overdue, then everything on track. Opening this page answers "who am I
 * neglecting" without filtering or sorting anything.
 */
export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; stage?: string; coach?: string }>;
}) {
  const coach = await requireCoachPage();
  const params = await searchParams;
  const coachId = scopeCoachId(coach, params.coach ?? null);

  const status = params.status === "won" || params.status === "lost" || params.status === "all"
    ? params.status
    : "open";

  const stages = await liveStages();
  const openStages = stages.filter((s) => s.terminal === null);

  const where = {
    ...prospectWhere(coachId),
    ...(params.stage ? { stageId: params.stage } : {}),
    ...(status === "open"
      ? { stage: { terminal: null } }
      : status === "won"
        ? { stage: { terminal: "WON" as const } }
        : status === "lost"
          ? { stage: { terminal: "LOST" as const } }
          : {}),
  };

  const prospects = await prisma.prospect.findMany({
    where,
    orderBy: [STALEST_FIRST, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      company: true,
      opportunityType: true,
      stageEnteredAt: true,
      nextActivityAt: true,
      convertedToClientId: true,
      stage: { select: { id: true, name: true, terminal: true, isHot: true } },
      assignedCoach: { select: { id: true, name: true } },
    },
  });

  // Last activity for the whole page in one query — never one per row.
  const lastByProspect = await lastActivityMap(prospects.map((p) => p.id));

  const coaches =
    coach.role === "COACH"
      ? [{ id: coach.id, name: coach.name }]
      : await prisma.coach.findMany({
          where: { status: { not: "INACTIVE" } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        });

  const unscheduled = prospects.filter((p) => !p.nextActivityAt && !p.stage.terminal).length;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Pipeline</h1>
          <p className="text-sm text-muted mt-1">
            {prospects.length} {status === "open" ? "open" : status} prospect
            {prospects.length === 1 ? "" : "s"}
            {unscheduled > 0 && (
              <>
                {" · "}
                <span className="text-error">{unscheduled} with nothing scheduled</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/pipeline/reports"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            Reports
          </Link>
          <AddProspectButton stages={openStages} coaches={coaches} />
        </div>
      </div>

      <Filters status={status} stage={params.stage} stages={openStages} />

      {prospects.length === 0 ? (
        <EmptyState status={status} stages={openStages} coaches={coaches} />
      ) : (
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Company</Th>
                  <Th className="hidden lg:table-cell">Opportunity</Th>
                  <Th>Stage</Th>
                  <Th className="hidden sm:table-cell">Days in stage</Th>
                  <Th>Next activity</Th>
                  <Th className="hidden lg:table-cell">Last activity</Th>
                  <Th className="hidden xl:table-cell">Coach</Th>
                </tr>
              </thead>
              <tbody>
                {prospects.map((p) => {
                  const last = lastByProspect.get(p.id);
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-b-0 hover:bg-background transition-colors"
                    >
                      <td className="px-5 py-4">
                        <Link
                          href={`/pipeline/${p.id}`}
                          className="font-display text-base text-foreground hover:text-accent transition-colors"
                        >
                          {`${p.firstName} ${p.lastName}`.trim()}
                        </Link>
                        <p className="text-xs text-muted mt-0.5 md:hidden">{p.company || "—"}</p>
                      </td>
                      <td className="px-5 py-4 text-sm text-muted hidden md:table-cell">
                        {p.company || "—"}
                      </td>
                      <td className="px-5 py-4 text-sm text-muted hidden lg:table-cell">
                        {titleCase(p.opportunityType)}
                      </td>
                      <td className="px-5 py-4">
                        <StageBadge name={p.stage.name} terminal={p.stage.terminal} isHot={p.stage.isHot} />
                      </td>
                      <td className="px-5 py-4 hidden sm:table-cell">
                        <DaysInStage since={p.stageEnteredAt} />
                      </td>
                      <td className="px-5 py-4">
                        <NextActivityCell
                          at={p.nextActivityAt}
                          closed={Boolean(p.stage.terminal)}
                        />
                      </td>
                      <td className="px-5 py-4 hidden lg:table-cell">
                        {last ? (
                          <div>
                            <span className="font-mono text-sm text-muted">
                              {formatDate(last.activityAt)}
                            </span>
                            {last.owner && (
                              <p className="text-xs text-muted mt-0.5">{last.owner.name}</p>
                            )}
                          </div>
                        ) : (
                          <span className="text-sm text-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-sm text-muted hidden xl:table-cell">
                        {p.assignedCoach?.name ?? (
                          <span className="text-muted/70">Unassigned</span>
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
    </div>
  );
}

/** Most recent completed activity per prospect, in two queries for the page. */
async function lastActivityMap(prospectIds: string[]) {
  const out = new Map<string, { activityAt: Date; owner: { name: string } | null }>();
  if (prospectIds.length === 0) return out;

  const latest = await prisma.pipelineActivity.groupBy({
    by: ["prospectId"],
    where: {
      prospectId: { in: prospectIds },
      OR: [{ kind: "LOGGED" }, { completedAt: { not: null } }],
    },
    _max: { activityAt: true },
  });
  if (latest.length === 0) return out;

  const rows = await prisma.pipelineActivity.findMany({
    where: {
      OR: latest
        .filter((l) => l._max.activityAt !== null)
        .map((l) => ({ prospectId: l.prospectId, activityAt: l._max.activityAt! })),
    },
    select: { prospectId: true, activityAt: true, owner: { select: { name: true } } },
  });

  for (const r of rows) {
    if (!out.has(r.prospectId)) out.set(r.prospectId, { activityAt: r.activityAt, owner: r.owner });
  }
  return out;
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

function Filters({
  status,
  stage,
  stages,
}: {
  status: string;
  stage?: string;
  stages: Array<{ id: string; name: string }>;
}) {
  const tabs = [
    { key: "open", label: "Open" },
    { key: "won", label: "Won" },
    { key: "lost", label: "Lost" },
    { key: "all", label: "All" },
  ];
  return (
    <div className="flex items-center gap-1 mb-4 flex-wrap">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`/pipeline?status=${t.key}${stage ? `&stage=${stage}` : ""}`}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            status === t.key
              ? "bg-accent-light text-accent font-medium"
              : "text-muted hover:text-foreground"
          }`}
        >
          {t.label}
        </Link>
      ))}
      {stage && (
        <Link
          href={`/pipeline?status=${status}`}
          className="ml-2 text-xs text-muted hover:text-foreground transition-colors"
        >
          Clear stage filter ({stages.find((s) => s.id === stage)?.name ?? "unknown"}) ✕
        </Link>
      )}
    </div>
  );
}

/**
 * Amber is the accent, so it cannot also mean "closed" — a won prospect uses
 * the success token and a lost one the muted border treatment. Hot stages get
 * the accent because that is the one thing on this table worth pulling the eye.
 */
function StageBadge({
  name,
  terminal,
  isHot,
}: {
  name: string;
  terminal: "WON" | "LOST" | null;
  isHot: boolean;
}) {
  const style =
    terminal === "WON"
      ? "bg-success/10 text-success border-success/25"
      : terminal === "LOST"
        ? "bg-background text-muted border-border"
        : isHot
          ? "bg-accent-light text-accent border-accent/25"
          : "bg-background text-foreground border-border";

  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded border whitespace-nowrap ${style}`}>
      {name}
    </span>
  );
}

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDate(d: Date) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The empty state describes what this page does and nothing else. No promises
 * of auto-capture: the only way a prospect gets here in v1 is someone typing
 * or pasting one, and saying otherwise would be a button that does nothing.
 */
function EmptyState({
  status,
  stages,
  coaches,
}: {
  status: string;
  stages: Array<{ id: string; name: string }>;
  coaches: Array<{ id: string; name: string }>;
}) {
  if (status !== "open") {
    return (
      <div className="text-center py-16">
        <h2 className="font-display text-xl text-foreground">Nothing here yet</h2>
        <p className="text-sm text-muted mt-2">
          No {status} prospects. They appear here once you close one.
        </p>
      </div>
    );
  }

  return (
    <div className="text-center py-16">
      <h2 className="font-display text-xl text-foreground">No prospects yet</h2>
      <p className="text-sm text-muted mt-2 mb-6 max-w-md mx-auto leading-relaxed">
        Track who you are talking to, what stage they are at, and what happens next. If you
        already keep a list somewhere, paste the whole thing in at once — name, company, what
        they need, email.
      </p>
      <div className="flex justify-center">
        <AddProspectButton stages={stages} coaches={coaches} />
      </div>
    </div>
  );
}
