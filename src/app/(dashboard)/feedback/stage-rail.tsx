import type { FeedbackStage } from "@/generated/prisma/enums";
import { STAGE_ORDER, STAGE_LABELS, stageIndex } from "@/lib/feedback";

/**
 * The signature element: a coach's report drawn as a rail they watch it travel.
 * Past stops are filled amber with a check, the live stop pulses, future stops
 * are muted. DECLINED is off-rail — it renders the distance actually travelled,
 * then a neutral terminal marker, never a "further step".
 *
 * Presentational and server-rendered: `reachedAt` is the first time each stage
 * was entered (from the stage-change history), used only to date the stops.
 */
export function StageRail({
  stage,
  reachedAt,
}: {
  stage: FeedbackStage;
  reachedAt: Partial<Record<FeedbackStage, Date>>;
}) {
  const declined = stage === "DECLINED";

  // How far did it get? For a live item that's its current index; for a
  // declined one it's the furthest linear stage it actually reached.
  const furthest = declined
    ? STAGE_ORDER.reduce((max, s, i) => (reachedAt[s] ? i : max), 0)
    : stageIndex(stage);

  const nodes = STAGE_ORDER.slice(0, declined ? furthest + 1 : STAGE_ORDER.length);

  return (
    <div className="flex items-start pt-1">
      {nodes.map((s, i) => {
        const isDone = i < furthest || (i === furthest && (declined || stage === "SHIPPED"));
        const isCurrent = !declined && i === furthest && stage !== "SHIPPED";
        return <Node key={s} label={STAGE_LABELS[s]} when={reachedAt[s]} first={i === 0} done={isDone} current={isCurrent} />;
      })}
      {declined && <Node label="Declined" when={reachedAt.DECLINED} first={false} declined />}
    </div>
  );
}

function Node({
  label,
  when,
  first,
  done = false,
  current = false,
  declined = false,
}: {
  label: string;
  when?: Date;
  first: boolean;
  done?: boolean;
  current?: boolean;
  declined?: boolean;
}) {
  const filled = done && !declined;
  return (
    <div className="relative flex flex-1 flex-col items-center">
      {/* connector to the previous node */}
      {!first && (
        <span
          className={`absolute top-[11px] right-1/2 left-[-50%] h-0.5 ${
            done || current ? "bg-accent" : declined ? "bg-muted/40" : "bg-border"
          }`}
        />
      )}

      <span
        className={`relative z-10 grid h-[22px] w-[22px] place-items-center rounded-full border-2 ${
          filled
            ? "border-accent bg-accent text-white"
            : current
              ? "border-accent bg-surface shadow-[0_0_0_4px_var(--accent-light)]"
              : declined
                ? "border-muted bg-surface"
                : "border-border bg-surface"
        }`}
      >
        {filled && (
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
        )}
        {current && <span className="h-[9px] w-[9px] animate-pulse rounded-full bg-accent motion-reduce:animate-none" />}
        {declined && (
          <svg className="h-3 w-3 text-muted" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        )}
      </span>

      <span
        className={`mt-2 text-center text-[10.5px] uppercase tracking-wide ${
          current
            ? "font-bold text-accent"
            : done && !declined
              ? "text-muted"
              : declined
                ? "text-muted"
                : "text-muted/60"
        }`}
      >
        {label}
      </span>
      {when && (
        <span className={`mt-0.5 font-mono text-[9.5px] ${current ? "text-accent" : "text-muted/70"}`}>
          {when.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      )}
    </div>
  );
}
