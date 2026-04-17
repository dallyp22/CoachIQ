import { addDays, addWeeks, addMonths, getDaysInMonth, setDate } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { BillingCadence } from "@/generated/prisma/client";

export interface CadenceOpts {
  cadence: BillingCadence;
  customCadenceDays?: number | null;
  defaultBillingDayOfMonth?: number | null;
  timezone: string;
}

/**
 * Compute the next invoice generation date from `from`, given a cadence.
 *
 * All math is done in the client's local timezone, then converted back to UTC
 * for storage. Handles end-of-month clamp (Feb 30 → Feb 28) and DST safely
 * because date-fns operations on zoned dates respect the local calendar.
 *
 * Examples (timezone America/Chicago):
 *   nextCadenceDate(2026-04-16, MONTHLY, dayOfMonth=15) → 2026-05-15 00:00 CDT
 *   nextCadenceDate(2026-01-31, MONTHLY, dayOfMonth=31) → 2026-02-28 00:00 CST
 *   nextCadenceDate(2026-04-16, BIWEEKLY)               → 2026-04-30 00:00 CDT
 *   nextCadenceDate(2026-04-16, CUSTOM_DAYS, days=21)   → 2026-05-07 00:00 CDT
 */
export function nextCadenceDate(from: Date, opts: CadenceOpts): Date {
  const tz = opts.timezone;
  const fromLocal = toZonedTime(from, tz);

  let nextLocal: Date;
  switch (opts.cadence) {
    case "WEEKLY":
      nextLocal = addWeeks(fromLocal, 1);
      break;
    case "BIWEEKLY":
      nextLocal = addWeeks(fromLocal, 2);
      break;
    case "MONTHLY": {
      const advanced = addMonths(fromLocal, 1);
      const dayOfMonth = opts.defaultBillingDayOfMonth ?? fromLocal.getDate();
      nextLocal = clampDayOfMonth(advanced, dayOfMonth);
      break;
    }
    case "CUSTOM_DAYS": {
      const days = opts.customCadenceDays;
      if (!days || days < 1 || days > 365) {
        throw new Error(
          `CUSTOM_DAYS cadence requires customCadenceDays between 1 and 365 (got ${days})`,
        );
      }
      nextLocal = addDays(fromLocal, days);
      break;
    }
    default: {
      const exhaustive: never = opts.cadence;
      throw new Error(`Unknown cadence: ${exhaustive}`);
    }
  }

  return fromZonedTime(nextLocal, tz);
}

/**
 * Clamp a date's day-of-month to the actual last day of that month.
 * setDate(date, 31) on a Feb date would roll to March; instead we clamp.
 */
export function clampDayOfMonth(date: Date, targetDay: number): Date {
  const lastDay = getDaysInMonth(date);
  return setDate(date, Math.min(targetDay, lastDay));
}

/**
 * For drift recovery: if `nextInvoiceDueAt` is stale (< now), advance it
 * forward in cadence steps until it's >= now. Returns the new date.
 * Caller still generates ONE invoice for the work-up-to-now period.
 */
export function advanceUntilFuture(
  staleDate: Date,
  now: Date,
  opts: CadenceOpts,
): Date {
  let cursor = staleDate;
  let safety = 0;
  while (cursor.getTime() <= now.getTime()) {
    cursor = nextCadenceDate(cursor, opts);
    safety++;
    if (safety > 1000) {
      throw new Error("advanceUntilFuture exceeded 1000 iterations — bad cadence");
    }
  }
  return cursor;
}
