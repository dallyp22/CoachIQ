import { requireCoachPage } from "@/lib/authz-page";
import { prisma } from "@/lib/db";
import type { FeedbackStage, FeedbackType } from "@/generated/prisma/enums";
import { TYPE_LABELS, isTerminalStage } from "@/lib/feedback";
import { StageRail } from "./stage-rail";
import { ReportButton } from "./report-button";
import { TriageControls } from "./triage-controls";
import { CommentForm } from "./comment-form";

export const dynamic = "force-dynamic";

/**
 * Feedback & Roadmap (Phase 1).
 *
 * A COACH sees their own reports and watches them move. ADMIN/OWNER sees every
 * report and can triage it inline. The public upvotable roadmap is Phase 2;
 * this is the trust core — submit, acknowledge, reply, ship, in the open.
 *
 * Declines are submitter-only by design: a coach only ever sees their own
 * items, and an admin sees all, so a declined item never becomes a public
 * "we said no to this" wall.
 */
export default async function FeedbackPage() {
  const coach = await requireCoachPage();
  const isAdmin = coach.role !== "COACH";

  const items = await prisma.feedbackItem.findMany({
    where: isAdmin ? {} : { submittedById: coach.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      stage: true,
      priority: true,
      pageUrl: true,
      appVersion: true,
      declineReason: true,
      githubUrl: true,
      createdAt: true,
      submittedBy: { select: { id: true, name: true } },
      changes: {
        orderBy: { changedAt: "asc" },
        select: { toStage: true, changedAt: true, note: true, changedById: true },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } },
      },
    },
  });

  // Active (still moving) floats above closed, so the pipeline reads top-down.
  const active = items.filter((i) => !isTerminalStage(i.stage));
  const closed = items.filter((i) => isTerminalStage(i.stage));
  const ordered = [...active, ...closed];

  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Feedback &amp; Roadmap</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted">
            {isAdmin
              ? "Every report from every coach. Move an item's stage, leave a note the reporter sees, and reply as the CoachIQ team."
              : "Report anything broken or missing. You'll see it acknowledged and watch it move through the pipeline — no more emailing into the void."}
          </p>
        </div>
        <ReportButton />
      </div>

      {isAdmin && items.length > 0 && (
        <p className="mt-4 font-mono text-xs text-muted">
          {active.length} open · {closed.length} closed
        </p>
      )}

      {ordered.length === 0 ? (
        <EmptyState isAdmin={isAdmin} />
      ) : (
        <div className="mt-6 space-y-4">
          {ordered.map((item) => {
            const reachedAt: Partial<Record<FeedbackStage, Date>> = {};
            for (const c of item.changes) {
              if (!reachedAt[c.toStage]) reachedAt[c.toStage] = c.changedAt;
            }
            const canComment = isAdmin || item.submittedBy.id === coach.id;
            return (
              <article
                key={item.id}
                id={item.id}
                className="rounded-[var(--radius-lg)] border border-border bg-surface p-5 sm:p-6"
              >
                {/* Header */}
                <div className="flex items-start gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display text-[20px] leading-tight text-foreground">{item.title}</h2>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11.5px] text-muted">
                      <span>#{item.id.slice(0, 8)}</span>
                      <span>
                        {item.submittedBy.id === coach.id ? "you" : item.submittedBy.name} ·{" "}
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

                {/* Body */}
                <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">{item.body}</p>

                {/* Rail */}
                <div className="mt-5">
                  <StageRail stage={item.stage} reachedAt={reachedAt} />
                </div>

                {/* Decline reason */}
                {item.stage === "DECLINED" && item.declineReason && (
                  <div className="mt-4 rounded-md border border-border bg-background px-3 py-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted">Why this was declined</p>
                    <p className="mt-1 text-sm text-foreground/90">{item.declineReason}</p>
                  </div>
                )}

                {/* Thread */}
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
                  <TriageControls
                    id={item.id}
                    stage={item.stage}
                    priority={item.priority}
                    githubUrl={item.githubUrl}
                  />
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
      <p className="font-display text-lg text-foreground">
        {isAdmin ? "No feedback yet" : "Nothing reported yet"}
      </p>
      <p className="mx-auto mt-1 max-w-[40ch] text-sm text-muted">
        {isAdmin
          ? "When a coach reports a bug or requests a feature, it lands here for you to triage."
          : "Hit a bug or wish something worked differently? Use Report — it takes ten seconds and you'll see exactly what happens next."}
      </p>
    </div>
  );
}
