import { describe, it, expect } from "vitest";
import {
  daysBetween,
  mean,
  averageAgeDays,
  averageTimeInStageDays,
  averageDaysSinceLastActivity,
  summarizeByStage,
  buildPipelineSummary,
  formatDays,
  type ProspectRow,
  type StageRow,
} from "@/lib/pipeline/report-math";

const NOW = new Date("2026-07-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const STAGES: StageRow[] = [
  { id: "s1", name: "New Lead", sortOrder: 1 },
  { id: "s2", name: "Contacted", sortOrder: 2 },
  { id: "s3", name: "Discovery Scheduled", sortOrder: 3 },
];

function prospect(over: Partial<ProspectRow> = {}): ProspectRow {
  return {
    id: "p1",
    stageId: "s1",
    createdAt: daysAgo(10),
    stageEnteredAt: daysAgo(4),
    lastActivityAt: daysAgo(2),
    ...over,
  };
}

describe("mean — the empty-set contract", () => {
  it("returns null for an empty list rather than NaN", () => {
    // sum/count with count 0 is NaN, which renders as "NaN days" on the very
    // first screen anyone sees. This is the single most likely day-one bug.
    expect(mean([])).toBeNull();
    expect(mean([])).not.toBeNaN();
  });

  it("averages a single value to itself", () => {
    expect(mean([7])).toBe(7);
  });

  it("averages several values", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("daysBetween", () => {
  it("counts whole and fractional days", () => {
    expect(daysBetween(daysAgo(3), NOW)).toBe(3);
    expect(daysBetween(new Date(NOW.getTime() - 43_200_000), NOW)).toBe(0.5);
  });

  it("floors at zero for a future date rather than reporting negative age", () => {
    // A planned activity scheduled ahead must never make a prospect read as
    // "-4 days old".
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(daysBetween(tomorrow, NOW)).toBe(0);
  });
});

describe("§7.2 averages — empty pipeline", () => {
  it("returns null for every statistic, never zero", () => {
    // Day one. Zero is a claim ("nothing is sitting"); null is the truth
    // ("nothing is here"). The distinction is what tells Todd the report is
    // empty rather than the pipeline healthy.
    expect(averageAgeDays([], NOW)).toBeNull();
    expect(averageTimeInStageDays([], NOW)).toBeNull();
    expect(averageDaysSinceLastActivity([], NOW)).toBeNull();
  });

  it("still lists every stage with a zero count", () => {
    // Omitting empty stages would redraw the funnel: a stage nobody has
    // reached would look identical to a stage that does not exist.
    const summary = summarizeByStage([], STAGES, NOW);
    expect(summary).toHaveLength(3);
    expect(summary.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(summary.map((s) => s.averageDaysSinceLastActivity)).toEqual([null, null, null]);
  });
});

describe("§7.2 averages — populated", () => {
  it("averages age on list", () => {
    const rows = [
      prospect({ id: "a", createdAt: daysAgo(10) }),
      prospect({ id: "b", createdAt: daysAgo(20) }),
    ];
    expect(averageAgeDays(rows, NOW)).toBe(15);
  });

  it("averages time in the current stage, not time on the list", () => {
    // A prospect 30 days old that moved stages yesterday is 1 day in stage.
    const rows = [prospect({ createdAt: daysAgo(30), stageEnteredAt: daysAgo(1) })];
    expect(averageTimeInStageDays(rows, NOW)).toBe(1);
    expect(averageAgeDays(rows, NOW)).toBe(30);
  });

  it("averages a single prospect to its own value", () => {
    expect(averageAgeDays([prospect({ createdAt: daysAgo(6) })], NOW)).toBe(6);
  });
});

describe("no-activities fallback (§7.2)", () => {
  it("uses createdAt when a prospect has never been touched", () => {
    const rows = [prospect({ createdAt: daysAgo(12), lastActivityAt: null })];
    expect(averageDaysSinceLastActivity(rows, NOW)).toBe(12);
  });

  it("includes untouched prospects rather than skipping them", () => {
    // The failure this guards: excluding untouched leads would make the
    // staleness metric IMPROVE as neglect grew — the exact inversion of what
    // the report is for. One touched 2 days ago, one never touched in 20 days.
    const rows = [
      prospect({ id: "touched", lastActivityAt: daysAgo(2) }),
      prospect({ id: "never", createdAt: daysAgo(20), lastActivityAt: null }),
    ];
    expect(averageDaysSinceLastActivity(rows, NOW)).toBe(11);
  });

  it("prefers a real activity date over createdAt when both exist", () => {
    const rows = [prospect({ createdAt: daysAgo(40), lastActivityAt: daysAgo(3) })];
    expect(averageDaysSinceLastActivity(rows, NOW)).toBe(3);
  });
});

describe("summarizeByStage", () => {
  it("orders by sortOrder regardless of input order", () => {
    const shuffled = [STAGES[2], STAGES[0], STAGES[1]];
    expect(summarizeByStage([], shuffled, NOW).map((s) => s.name)).toEqual([
      "New Lead",
      "Contacted",
      "Discovery Scheduled",
    ]);
  });

  it("buckets prospects into their stage", () => {
    const rows = [
      prospect({ id: "a", stageId: "s1" }),
      prospect({ id: "b", stageId: "s1" }),
      prospect({ id: "c", stageId: "s3" }),
    ];
    expect(summarizeByStage(rows, STAGES, NOW).map((s) => s.count)).toEqual([2, 0, 1]);
  });

  it("computes staleness per stage independently", () => {
    const rows = [
      prospect({ id: "a", stageId: "s1", lastActivityAt: daysAgo(4) }),
      prospect({ id: "b", stageId: "s3", lastActivityAt: daysAgo(10) }),
    ];
    const byStage = summarizeByStage(rows, STAGES, NOW);
    expect(byStage[0].averageDaysSinceLastActivity).toBe(4);
    expect(byStage[1].averageDaysSinceLastActivity).toBeNull();
    expect(byStage[2].averageDaysSinceLastActivity).toBe(10);
  });

  it("ignores prospects whose stage is not in the stage list", () => {
    // An archived stage still holds historical prospects; the open-stage
    // summary must not invent a row for it.
    const rows = [prospect({ stageId: "archived-stage" })];
    const byStage = summarizeByStage(rows, STAGES, NOW);
    expect(byStage).toHaveLength(3);
    expect(byStage.every((s) => s.count === 0)).toBe(true);
  });
});

describe("buildPipelineSummary", () => {
  it("assembles the whole report", () => {
    const rows = [
      prospect({ id: "a", stageId: "s1", createdAt: daysAgo(10), stageEnteredAt: daysAgo(2), lastActivityAt: daysAgo(1) }),
      prospect({ id: "b", stageId: "s3", createdAt: daysAgo(20), stageEnteredAt: daysAgo(4), lastActivityAt: daysAgo(3) }),
    ];
    const summary = buildPipelineSummary(rows, STAGES, NOW);

    expect(summary.totalOpen).toBe(2);
    expect(summary.averageAgeDays).toBe(15);
    expect(summary.averageTimeInStageDays).toBe(3);
    expect(summary.averageDaysSinceLastActivity).toBe(2);
    expect(summary.byStage.map((s) => s.count)).toEqual([1, 0, 1]);
  });

  it("survives an empty pipeline with no NaN anywhere", () => {
    const summary = buildPipelineSummary([], STAGES, NOW);
    expect(summary.totalOpen).toBe(0);
    for (const value of [
      summary.averageAgeDays,
      summary.averageTimeInStageDays,
      summary.averageDaysSinceLastActivity,
    ]) {
      expect(value).toBeNull();
    }
    // Stages still render on an empty pipeline — the bar chart's shape is the
    // report's main signal, and an empty chart is different from no chart.
    expect(summary.byStage).toHaveLength(3);
    expect(summary.byStage.every((s) => s.count === 0)).toBe(true);
  });
});

describe("formatDays", () => {
  it("renders an em-dash for no data, never 0", () => {
    expect(formatDays(null)).toBe("—");
    expect(formatDays(null)).not.toBe("0.0d");
  });

  it("renders a real zero as zero — a lead added today is 0 days old", () => {
    // Distinct from null: this prospect exists and its age is genuinely zero.
    expect(formatDays(0)).toBe("0.0d");
  });

  it("rounds to one decimal", () => {
    expect(formatDays(3.14159)).toBe("3.1d");
  });
});
