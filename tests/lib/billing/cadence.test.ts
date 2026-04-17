import { describe, it, expect } from "vitest";
import {
  nextCadenceDate,
  clampDayOfMonth,
  advanceUntilFuture,
  type CadenceOpts,
} from "@/lib/billing/cadence";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

const CHICAGO = "America/Chicago";

/** Build a Date that represents `localISO` interpreted in `tz`. */
function dateAt(localISO: string, tz: string): Date {
  return fromZonedTime(localISO, tz);
}

/** Format a UTC Date back into "YYYY-MM-DD HH:mm" in the given tz. */
function localStr(d: Date, tz: string): string {
  const z = toZonedTime(d, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())} ${pad(z.getHours())}:${pad(z.getMinutes())}`;
}

describe("clampDayOfMonth", () => {
  // clampDayOfMonth wraps date-fns setDate, which operates in local time.
  // We test against zoned dates (already in the target tz) and read .getDate()
  // so behavior is timezone-independent on the test runner.
  it("returns the target day when it exists in the month", () => {
    const d = dateAt("2026-04-10T00:00:00", CHICAGO);
    expect(clampDayOfMonth(toZonedTime(d, CHICAGO), 15).getDate()).toBe(15);
  });

  it("clamps Feb 31 to Feb 28 in a non-leap year", () => {
    const d = toZonedTime(dateAt("2026-02-10T00:00:00", CHICAGO), CHICAGO);
    expect(clampDayOfMonth(d, 31).getDate()).toBe(28);
  });

  it("clamps Feb 31 to Feb 29 in a leap year", () => {
    const d = toZonedTime(dateAt("2024-02-10T00:00:00", CHICAGO), CHICAGO);
    expect(clampDayOfMonth(d, 31).getDate()).toBe(29);
  });

  it("clamps April 31 to April 30", () => {
    const d = toZonedTime(dateAt("2026-04-10T00:00:00", CHICAGO), CHICAGO);
    expect(clampDayOfMonth(d, 31).getDate()).toBe(30);
  });

  it("returns target day unchanged when ≤ last day", () => {
    const d = toZonedTime(dateAt("2026-04-10T00:00:00", CHICAGO), CHICAGO);
    expect(clampDayOfMonth(d, 1).getDate()).toBe(1);
    expect(clampDayOfMonth(d, 30).getDate()).toBe(30);
  });
});

describe("nextCadenceDate — WEEKLY", () => {
  it("advances exactly 7 days in local time", () => {
    const from = dateAt("2026-04-16T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "WEEKLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-04-23 00:00");
  });

  it("crosses DST start (Mar 8 2026 spring-forward) without skipping a day", () => {
    // Mar 1 → Mar 8 in America/Chicago crosses the spring-forward boundary
    const from = dateAt("2026-03-01T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "WEEKLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-03-08 00:00");
  });

  it("crosses DST end (Nov 1 2026 fall-back) without doubling a day", () => {
    const from = dateAt("2026-10-25T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "WEEKLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-11-01 00:00");
  });
});

describe("nextCadenceDate — BIWEEKLY", () => {
  it("advances exactly 14 days", () => {
    const from = dateAt("2026-04-16T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "BIWEEKLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-04-30 00:00");
  });
});

describe("nextCadenceDate — MONTHLY", () => {
  it("advances by 1 month, preserving the day", () => {
    const from = dateAt("2026-04-15T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "MONTHLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-05-15 00:00");
  });

  it("uses defaultBillingDayOfMonth when provided (overrides the from-day)", () => {
    const from = dateAt("2026-04-16T00:00:00", CHICAGO);
    const opts: CadenceOpts = {
      cadence: "MONTHLY",
      timezone: CHICAGO,
      defaultBillingDayOfMonth: 1,
    };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-05-01 00:00");
  });

  it("clamps Jan 31 → Feb 28 in a non-leap year", () => {
    const from = dateAt("2026-01-31T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "MONTHLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-02-28 00:00");
  });

  it("clamps Jan 31 → Feb 29 in a leap year (2024)", () => {
    const from = dateAt("2024-01-31T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "MONTHLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2024-02-29 00:00");
  });

  it("clamps defaultBillingDayOfMonth=31 against shorter months", () => {
    const from = dateAt("2026-01-15T00:00:00", CHICAGO);
    const opts: CadenceOpts = {
      cadence: "MONTHLY",
      timezone: CHICAGO,
      defaultBillingDayOfMonth: 31,
    };
    const next = nextCadenceDate(from, opts);
    // Feb has 28 in 2026 → clamped to Feb 28
    expect(localStr(next, CHICAGO)).toBe("2026-02-28 00:00");
  });

  it("crosses DST (March) without distorting the date", () => {
    const from = dateAt("2026-02-15T00:00:00", CHICAGO);
    const opts: CadenceOpts = { cadence: "MONTHLY", timezone: CHICAGO };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-03-15 00:00");
  });
});

describe("nextCadenceDate — CUSTOM_DAYS", () => {
  it("advances by the specified number of days", () => {
    const from = dateAt("2026-04-16T00:00:00", CHICAGO);
    const opts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: 21,
      timezone: CHICAGO,
    };
    const next = nextCadenceDate(from, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-05-07 00:00");
  });

  it("rejects null customCadenceDays", () => {
    const from = dateAt("2026-04-16T00:00:00", CHICAGO);
    const opts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: null,
      timezone: CHICAGO,
    };
    expect(() => nextCadenceDate(from, opts)).toThrow(/customCadenceDays/);
  });

  it("rejects zero customCadenceDays", () => {
    const opts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: 0,
      timezone: CHICAGO,
    };
    expect(() => nextCadenceDate(new Date(), opts)).toThrow(/customCadenceDays/);
  });

  it("rejects negative customCadenceDays", () => {
    const opts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: -5,
      timezone: CHICAGO,
    };
    expect(() => nextCadenceDate(new Date(), opts)).toThrow(/customCadenceDays/);
  });

  it("rejects customCadenceDays > 365", () => {
    const opts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: 366,
      timezone: CHICAGO,
    };
    expect(() => nextCadenceDate(new Date(), opts)).toThrow(/customCadenceDays/);
  });

  it("accepts boundary value 365", () => {
    const from = dateAt("2026-01-01T00:00:00", CHICAGO);
    const opts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: 365,
      timezone: CHICAGO,
    };
    const next = nextCadenceDate(from, opts);
    // 2026 is non-leap → 2027-01-01
    expect(localStr(next, CHICAGO)).toBe("2027-01-01 00:00");
  });
});

describe("advanceUntilFuture — drift recovery", () => {
  const opts: CadenceOpts = { cadence: "MONTHLY", timezone: CHICAGO };

  it("returns the next-cadence date when stale by < 1 cycle", () => {
    const stale = dateAt("2026-04-01T00:00:00", CHICAGO);
    const now = dateAt("2026-04-16T00:00:00", CHICAGO);
    const next = advanceUntilFuture(stale, now, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-05-01 00:00");
  });

  it("advances past multiple missed cycles to first future date", () => {
    const stale = dateAt("2026-01-01T00:00:00", CHICAGO);
    const now = dateAt("2026-04-16T00:00:00", CHICAGO);
    const next = advanceUntilFuture(stale, now, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-05-01 00:00");
  });

  it("returns input unchanged when stale is already in the future", () => {
    // Loop condition is cursor <= now; if stale > now, body never runs.
    const stale = dateAt("2026-12-01T00:00:00", CHICAGO);
    const now = dateAt("2026-04-16T00:00:00", CHICAGO);
    const next = advanceUntilFuture(stale, now, opts);
    expect(localStr(next, CHICAGO)).toBe("2026-12-01 00:00");
  });

  it("safety: throws if cadence somehow doesn't advance (paranoid)", () => {
    const badOpts: CadenceOpts = {
      cadence: "CUSTOM_DAYS",
      customCadenceDays: 1,
      timezone: CHICAGO,
    };
    // 1-day cadence advancing 1000+ steps should hit the safety bail
    const stale = dateAt("2020-01-01T00:00:00", CHICAGO);
    const now = dateAt("2026-04-16T00:00:00", CHICAGO);
    expect(() => advanceUntilFuture(stale, now, badOpts)).toThrow(/exceeded 1000 iterations/);
  });
});

describe("nextCadenceDate — invalid cadence guard", () => {
  it("throws on unknown cadence value", () => {
    const opts = {
      cadence: "INVALID" as unknown as CadenceOpts["cadence"],
      timezone: CHICAGO,
    };
    expect(() => nextCadenceDate(new Date(), opts)).toThrow(/Unknown cadence/);
  });
});
