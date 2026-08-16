import Link from "next/link";
import type { FeedbackStage, FeedbackType } from "@/generated/prisma/enums";
import { ALL_STAGES, STAGE_LABELS, TYPE_LABELS } from "@/lib/feedback";
import { VoteButton } from "./vote-button";

/**
 * Every item grouped by stage — the pipeline read left-to-right, sorted by
 * demand within each column. A read surface: cards link into the List view
 * (anchored to the item) where triage and the thread live, so the board stays
 * scannable. Columns scroll sideways inside their own container; the page body
 * never does.
 */
export type BoardItem = {
  id: string;
  type: FeedbackType;
  title: string;
  priority: string | null;
  stage: FeedbackStage;
  voteCount: number;
  voted: boolean;
  submittedBy: { id: string; name: string };
};

// A stripe color per stage — semantic, distinct from the amber accent.
const STAGE_STRIPE: Record<FeedbackStage, string> = {
  SUBMITTED: "var(--muted)",
  ACKNOWLEDGED: "var(--warning)",
  INVESTIGATING: "var(--info)",
  PLANNED: "var(--accent)",
  IN_PROGRESS: "var(--accent)",
  SHIPPED: "var(--success)",
  DECLINED: "var(--error)",
};

export function Board({ items, meId }: { items: BoardItem[]; meId: string }) {
  const byStage = new Map<FeedbackStage, BoardItem[]>();
  for (const s of ALL_STAGES) byStage.set(s, []);
  for (const item of items) byStage.get(item.stage)!.push(item);

  return (
    <div className="mt-6 overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
        {ALL_STAGES.map((stage) => {
          const col = byStage.get(stage)!;
          return (
            <section
              key={stage}
              className="flex w-[220px] flex-none flex-col rounded-[var(--radius-lg)] border border-border bg-background/60 p-3"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: STAGE_STRIPE[stage] }} />
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{STAGE_LABELS[stage]}</span>
                <span className="ml-auto font-mono text-[11px] text-muted/70">{col.length}</span>
              </div>

              <div className="flex flex-col gap-2">
                {col.length === 0 ? (
                  <p className="py-2 text-center text-[11px] text-muted/50">—</p>
                ) : (
                  col.map((item) => (
                    <Link
                      key={item.id}
                      href={`/feedback?view=list#${item.id}`}
                      className="block rounded-md border border-border bg-surface p-2.5 transition-colors hover:border-accent"
                    >
                      <div className="flex gap-2.5">
                        <VoteButton id={item.id} voteCount={item.voteCount} voted={item.voted} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium leading-snug text-foreground">{item.title}</p>
                          <div className="mt-2 flex items-center gap-2">
                            <span
                              className={`text-[10px] font-bold uppercase tracking-wide ${
                                item.type === "BUG" ? "text-error" : "text-info"
                              }`}
                            >
                              {TYPE_LABELS[item.type]}
                            </span>
                            {item.priority && (
                              <span className="rounded-full border border-border px-1.5 text-[9px] uppercase tracking-wide text-muted">
                                {item.priority.toLowerCase()}
                              </span>
                            )}
                            <span className="ml-auto truncate font-mono text-[10px] text-muted/70">
                              {item.submittedBy.id === meId ? "you" : item.submittedBy.name.split(/\s+/)[0]}
                            </span>
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
