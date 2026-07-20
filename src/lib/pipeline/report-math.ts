/**
 * Pipeline Summary arithmetic (PRD §7.2), as pure functions over plain rows.
 *
 * Every statistic in that report is a mean, and on day one every set is empty:
 * `sum / count` with count 0 is NaN in JS and null in SQL. Extracting the math
 * here makes the empty pipeline, the empty stage, the single row, and the
 * "no activities yet" fallback cheap unit tests with no database.
 *
 * NO STAT IS EVER ZERO WHEN IT MEANS "NO DATA". These functions return null,
 * and the UI renders null as an em-dash. "0 days in stage" reads as "nothing
 * is sitting here"; the truth is "nothing is here" — a different fact, and the
 * one that tells you the report is empty rather than the pipeline is healthy.
 */

const MS_PER_DAY = 86_400_000;

export type ProspectRow = {
  id: string;
  stageId: string;
  createdAt: Date;
  stageEnteredAt: Date;
  /**
   * Most recent LOGGED (or completed) activity. Null when the prospect has
   * never been touched — §7.2 says those fall back to createdAt, which is the
   * honest reading: the clock starts when the lead entered the pipeline.
   */
  lastActivityAt: Date | null;
};

export type StageRow = {
  id: string;
  name: string;
  sortOrder: number;
};

/** Whole days between two instants, floored at 0. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Mean of a list, or null when there is nothing to average.
 *
 * The null is the entire point — see the file header. Callers must not
 * `?? 0` this.
 */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return total / values.length;
}

/** Mean age on list: now − createdAt, in days. */
export function averageAgeDays(prospects: ProspectRow[], now: Date): number | null {
  return mean(prospects.map((p) => daysBetween(p.createdAt, now)));
}

/** Mean time in the CURRENT stage: now − stageEnteredAt, in days. */
export function averageTimeInStageDays(prospects: ProspectRow[], now: Date): number | null {
  return mean(prospects.map((p) => daysBetween(p.stageEnteredAt, now)));
}

/**
 * Mean time since last activity, in days.
 *
 * A prospect with zero activities uses createdAt (PRD §7.2). Without that
 * fallback the untouched prospects — the ones this metric exists to expose —
 * would be excluded from it, and the number would improve as neglect grew.
 */
export function averageDaysSinceLastActivity(
  prospects: ProspectRow[],
  now: Date
): number | null {
  return mean(prospects.map((p) => daysBetween(p.lastActivityAt ?? p.createdAt, now)));
}

export type StageSummary = {
  stageId: string;
  name: string;
  sortOrder: number;
  count: number;
  /** null when the stage holds no prospects — not 0. */
  averageDaysSinceLastActivity: number | null;
};

/**
 * Per-stage counts and staleness, ordered by sortOrder.
 *
 * Every non-archived open stage appears, INCLUDING empty ones. Omitting empty
 * stages would silently redraw the funnel: a stage nobody has reached looks
 * identical to a stage that does not exist, and the bar chart's shape is the
 * report's main signal.
 */
export function summarizeByStage(
  prospects: ProspectRow[],
  stages: StageRow[],
  now: Date
): StageSummary[] {
  const byStage = new Map<string, ProspectRow[]>();
  for (const p of prospects) {
    const bucket = byStage.get(p.stageId);
    if (bucket) bucket.push(p);
    else byStage.set(p.stageId, [p]);
  }

  return [...stages]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((stage) => {
      const rows = byStage.get(stage.id) ?? [];
      return {
        stageId: stage.id,
        name: stage.name,
        sortOrder: stage.sortOrder,
        count: rows.length,
        averageDaysSinceLastActivity: averageDaysSinceLastActivity(rows, now),
      };
    });
}

export type PipelineSummary = {
  totalOpen: number;
  averageAgeDays: number | null;
  averageTimeInStageDays: number | null;
  averageDaysSinceLastActivity: number | null;
  byStage: StageSummary[];
};

/** The whole of PRD §7.2 in one call. `prospects` must already be open-only. */
export function buildPipelineSummary(
  prospects: ProspectRow[],
  stages: StageRow[],
  now: Date
): PipelineSummary {
  return {
    totalOpen: prospects.length,
    averageAgeDays: averageAgeDays(prospects, now),
    averageTimeInStageDays: averageTimeInStageDays(prospects, now),
    averageDaysSinceLastActivity: averageDaysSinceLastActivity(prospects, now),
    byStage: summarizeByStage(prospects, stages, now),
  };
}

/**
 * Render a day-count for display: one decimal, or an em-dash when there is no
 * data. Kept beside the math so the null contract cannot drift from the UI.
 */
export function formatDays(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}d`;
}
