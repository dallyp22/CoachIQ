/**
 * The two cells that carry PRD §6.2's attention states.
 *
 * These are the manual process's safety net: nothing in this module reminds
 * anyone of anything, so the only thing standing between a lead and silence is
 * whether the row looks wrong at a glance.
 *
 * Server components on purpose. They read the clock, and a client component
 * that formats a relative date rehydrates against a slightly different `now`
 * — React logs a mismatch and the first paint can flip. The page is
 * force-dynamic, so the server clock is fresh on every request anyway.
 */

const MS_PER_DAY = 86_400_000;

function wholeDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - new Date(from).getTime()) / MS_PER_DAY);
}

/**
 * Next activity — three states, and the empty one is the loudest.
 *
 * "None scheduled" is not a missing value; it is the condition this module
 * exists to surface, so it reads as an error rather than an em-dash. Overdue
 * is amber, not red: a call that slipped two days is a nudge, not a failure,
 * and using the same weight for both would flatten the difference.
 *
 * A closed prospect shows neither — nagging about a finished deal trains
 * people to ignore the column.
 */
export function NextActivityCell({ at, closed }: { at: Date | null; closed: boolean }) {
  if (closed) return <span className="text-sm text-muted">—</span>;

  if (!at) {
    return (
      <span className="text-sm text-error whitespace-nowrap">None scheduled</span>
    );
  }

  const now = new Date();
  const days = wholeDays(at, now);

  if (days > 0) {
    return (
      <span className="font-mono text-sm text-warning whitespace-nowrap">
        {formatDate(at)}
        <span className="ml-1.5 text-xs">
          {days}d late
        </span>
      </span>
    );
  }

  return (
    <span className="font-mono text-sm text-foreground whitespace-nowrap">
      {formatDate(at)}
      {days === 0 && <span className="ml-1.5 text-xs text-accent">today</span>}
    </span>
  );
}

/**
 * Days in the current stage. Plain until it is long enough to be a question —
 * a lead sitting in one stage for a month is the second-best staleness signal
 * after having nothing scheduled, but it is normal at week one and shouting
 * about it immediately would make the colour meaningless.
 */
export function DaysInStage({ since }: { since: Date }) {
  const days = Math.max(0, wholeDays(since, new Date()));
  const stale = days >= 30;

  return (
    <span
      className={`font-mono text-sm tabular-nums ${stale ? "text-warning" : "text-muted"}`}
      title={stale ? `In this stage since ${formatDate(since)}` : undefined}
    >
      {days}d
    </span>
  );
}

function formatDate(d: Date) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
