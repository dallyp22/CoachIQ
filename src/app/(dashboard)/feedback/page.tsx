import { requireCoachPage } from "@/lib/authz-page";
import { prisma } from "@/lib/db";
import type { FeedbackStage, FeedbackType } from "@/generated/prisma/enums";
import { TYPE_LABELS, isTerminalStage } from "@/lib/feedback";
import { StageRail } from "./stage-rail";
import { ReportButton } from "./report-button";
import { TriageControls } from "./triage-controls";
import { CommentForm } from "./comment-form";
import { DeleteButton } from "./delete-button";
import { ViewToggle } from "./view-toggle";
import { Board } from "./board";
import { VoteButton } from "./vote-button";
import { MarkSeen } from "./mark-seen";

export const dynamic = "force-dynamic";

/**
 * Feedback & Roadmap.
 *
 * Three views on one URL:
 *   - List  — a coach's own reports (admin: all), with the stage rail, thread,
 *     triage, delete, and a vote button.
 *   - Board — the cross-coach roadmap: every non-declined item grouped by stage
 *     and sorted by demand. A declined item stays visible only to its author.
 *   - What's New — everything shipped, newest first, grouped by version.
 *
 * Opening the page marks feedback seen (clears the nav badge) via <MarkSeen/>.
 */
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const coach = await requireCoachPage();
  const isAdmin = coach.role !== "COACH";
  const raw = (await searchParams).view;
  const view = raw === "board" ? "board" : raw === "whatsnew" ? "whatsnew" : "list";

  return (
    <div>
      <MarkSeen />

      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Feedback &amp; Roadmap</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted">
            {isAdmin
              ? "Every report from every coach. Move an item's stage, leave a note the reporter sees, and reply as the CoachIQ team."
              : "Report anything broken or missing, upvote what you want next, and watch it move through the pipeline in the open."}
          </p>
        </div>
        <ReportButton />
      </div>

      <ViewToggle view={view} />

      {view === "board" ? (
        <BoardView coachId={coach.id} isAdmin={isAdmin} />
      ) : view === "whatsnew" ? (
        <WhatsNewView />
      ) : (
        <ListView coachId={coach.id} isAdmin={isAdmin} />
      )}
    </div>
  );
}

// ─── List ─────────────────────────────────────────────

async function ListView({ coachId, isAdmin }: { coachId: string; isAdmin: boolean }) {
  const items = await prisma.feedbackItem.findMany({
    where: isAdmin ? {} : { submittedById: coachId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      stage: true,
      priority: true,
      appVersion: true,
      declineReason: true,
      githubUrl: true,
      voteCount: true,
      createdAt: true,
      submittedBy: { select: { id: true, name: true } },
      changes: {
        orderBy: { changedAt: "asc" },
        select: { toStage: true, changedAt: true },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } },
      },
      votes: { where: { coachId }, select: { coachId: true } },
    },
  });

  if (items.length === 0) return <EmptyState isAdmin={isAdmin} />;

  const active = items.filter((i) => !isTerminalStage(i.stage));
  const closed = items.filter((i) => isTerminalStage(i.stage));
  const ordered = [...active, ...closed];

  return (
    <>
      {isAdmin && (
        <p className="mt-4 font-mono text-xs text-muted">
          {active.length} open · {closed.length} closed
        </p>
      )}
      <div className="mt-6 space-y-4">
        {ordered.map((item) => {
          const reachedAt: Partial<Record<FeedbackStage, Date>> = {};
          for (const c of item.changes) {
            if (!reachedAt[c.toStage]) reachedAt[c.toStage] = c.changedAt;
          }
          const canComment = isAdmin || item.submittedBy.id === coachId;
          return (
            <article
              key={item.id}
              id={item.id}
              className="scroll-mt-20 rounded-[var(--radius-lg)] border border-border bg-surface p-5 sm:p-6"
            >
              <div className="flex items-start gap-3">
                <VoteButton id={item.id} voteCount={item.voteCount} voted={item.votes.length > 0} />
                <div className="min-w-0">
                  <h2 className="font-display text-[20px] leading-tight text-foreground">{item.title}</h2>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11.5px] text-muted">
                    <span>#{item.id.slice(0, 8)}</span>
                    <span>
                      {item.submittedBy.id === coachId ? "you" : item.submittedBy.name} ·{" "}
                      {item.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    {item.appVersion && <span>{item.appVersion}</span>}
                    {item.githubUrl && (
                      <a href={item.githubUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        GitHub ↗
                      </a>
                    )}
                  </div>
                </div>
                <div className="ml-auto flex flex-none items-center gap-2">
                  {item.priority && item.stage !== "SHIPPED" && item.stage !== "DECLINED" && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                      {item.priority.toLowerCase()}
                    </span>
                  )}
                  <TypeChip type={item.type} />
                </div>
              </div>

              <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">{item.body}</p>

              <div className="mt-5">
                <StageRail stage={item.stage} reachedAt={reachedAt} />
              </div>

              {item.stage === "DECLINED" && item.declineReason && (
                <div className="mt-4 rounded-md border border-border bg-background px-3 py-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Why this was declined</p>
                  <p className="mt-1 text-sm text-foreground/90">{item.declineReason}</p>
                </div>
              )}

              {item.comments.length > 0 && (
                <div className="mt-5 space-y-3 border-t border-dashed border-border pt-4">
                  {item.comments.map((c) => (
                    <div key={c.id} className="flex gap-3">
                      <Avatar name={c.author?.name ?? null} />
                      <div className="min-w-0">
                        <p className="text-[12.5px] font-semibold text-foreground">
                          {c.author?.name ?? "CoachIQ Team"}
                          <span className="ml-2 font-mono text-[11px] font-normal text-muted">
                            {c.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">{c.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {canComment && <CommentForm id={item.id} canPostAsTeam={isAdmin} />}

              {isAdmin && (
                <TriageControls id={item.id} stage={item.stage} priority={item.priority} githubUrl={item.githubUrl} />
              )}

              {canComment && (
                <div className="mt-4 flex justify-end">
                  <DeleteButton id={item.id} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

// ─── Board (roadmap) ──────────────────────────────────

async function BoardView({ coachId, isAdmin }: { coachId: string; isAdmin: boolean }) {
  // Cross-coach roadmap: everyone sees every non-declined item; a declined item
  // stays visible only to whoever filed it. Sorted by demand within each column.
  const items = await prisma.feedbackItem.findMany({
    where: isAdmin ? {} : { OR: [{ stage: { not: "DECLINED" } }, { submittedById: coachId }] },
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      type: true,
      title: true,
      priority: true,
      stage: true,
      voteCount: true,
      submittedBy: { select: { id: true, name: true } },
      votes: { where: { coachId }, select: { coachId: true } },
    },
  });

  if (items.length === 0) return <EmptyState isAdmin={isAdmin} />;

  return (
    <Board
      meId={coachId}
      items={items.map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        priority: i.priority,
        stage: i.stage,
        voteCount: i.voteCount,
        voted: i.votes.length > 0,
        submittedBy: i.submittedBy,
      }))}
    />
  );
}

// ─── What's New ───────────────────────────────────────

async function WhatsNewView() {
  const shipped = await prisma.feedbackItem.findMany({
    where: { stage: "SHIPPED" },
    orderBy: [{ shippedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      type: true,
      title: true,
      shippedAt: true,
      shippedInVersion: true,
      submittedBy: { select: { name: true } },
    },
  });

  if (shipped.length === 0) {
    return (
      <div className="mt-8 rounded-[var(--radius-lg)] border border-dashed border-border bg-surface px-6 py-14 text-center">
        <p className="font-display text-lg text-foreground">Nothing shipped yet</p>
        <p className="mx-auto mt-1 max-w-[40ch] text-sm text-muted">
          When a request or bug reaches Shipped, it shows up here so everyone can see what&apos;s new.
        </p>
      </div>
    );
  }

  // Group by version, preserving the shipped-desc order versions first appear in.
  const groups: Array<{ version: string; items: typeof shipped }> = [];
  for (const item of shipped) {
    const version = item.shippedInVersion ?? "Recently";
    const last = groups[groups.length - 1];
    if (last && last.version === version) last.items.push(item);
    else groups.push({ version, items: [item] });
  }

  return (
    <div className="mt-6 space-y-8">
      {groups.map((g) => (
        <section key={g.version}>
          <div className="flex items-baseline gap-3">
            <h2 className="font-mono text-sm font-semibold text-accent">
              {g.version === "Recently" ? "Recently" : `v${g.version}`}
            </h2>
            <span className="h-px flex-1 bg-border" />
          </div>
          <ul className="mt-3 space-y-2">
            {g.items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-3 rounded-md border border-border bg-surface px-4 py-3">
                <span
                  className={`text-[10px] font-bold uppercase tracking-wide ${
                    item.type === "BUG" ? "text-error" : "text-info"
                  }`}
                >
                  {item.type === "BUG" ? "Fixed" : "Shipped"}
                </span>
                <span className="min-w-0 flex-1 text-sm text-foreground">{item.title}</span>
                <span className="flex-none font-mono text-[11px] text-muted">
                  {item.shippedAt
                    ? item.shippedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Bits ─────────────────────────────────────────────

function TypeChip({ type }: { type: FeedbackType }) {
  const bug = type === "BUG";
  return (
    <span
      className={`inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
        bug ? "bg-error/10 text-error" : "bg-info/10 text-info"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {TYPE_LABELS[type]}
    </span>
  );
}

function Avatar({ name }: { name: string | null }) {
  const team = !name;
  const initials = team
    ? "C"
    : name
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("");
  return (
    <span
      className={`grid h-7 w-7 flex-none place-items-center rounded-full text-[11px] font-semibold ${
        team ? "bg-sidebar font-display text-accent" : "bg-accent text-white"
      }`}
    >
      {initials}
    </span>
  );
}

function EmptyState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="mt-8 rounded-[var(--radius-lg)] border border-dashed border-border bg-surface px-6 py-14 text-center">
      <p className="font-display text-lg text-foreground">{isAdmin ? "No feedback yet" : "Nothing here yet"}</p>
      <p className="mx-auto mt-1 max-w-[40ch] text-sm text-muted">
        {isAdmin
          ? "When a coach reports a bug or requests a feature, it lands here for you to triage."
          : "Hit a bug or wish something worked differently? Use Report — it takes ten seconds and you'll see exactly what happens next."}
      </p>
    </div>
  );
}
