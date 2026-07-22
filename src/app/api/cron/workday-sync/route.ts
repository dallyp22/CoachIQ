import { NextRequest, NextResponse } from "next/server";
import { syncCalendarSessions } from "@/lib/calendar-sync";
import { deliverDueBriefs, type DeliverBriefsResult } from "@/lib/deliver-briefs";
import { verifyCronSecret } from "@/lib/cron-auth";

// One run can process a weekend backlog of sessions, each brief a sequential
// LLM call — declare the full Fluid Compute allowance so the loop is never
// killed mid-flight by a shorter plan default.
export const maxDuration = 300;

// Sync lookback must cover the longest gap between runs: Friday 18:00 UTC →
// Monday 12:00 UTC is 66h, so 72h with slack. The calendarEventId dedup in
// syncCalendarSessions makes the wide window idempotent.
const SYNC_LOOKBACK_HOURS = 72;

/**
 * GET /api/cron/workday-sync — the single workday tick.
 *
 * Replaces the separate calendar-sync and deliver-briefs crons. Runs twice a
 * day — 12:00 and 18:00 UTC (7am/1pm CDT, 6am/noon CST), weekdays. The
 * invoice-generation cron fires at 12:05 weekdays, inside the same Neon
 * wake window (the DB is still warm from this run) — so cron traffic wakes
 * the Neon database twice per weekday and never on weekends, and it
 * autosuspends the rest of the time.
 *
 * 1. Calendar sync: past 72h (covers the weekend gap) + next 24h of events
 *    → sessions/time entries.
 * 2. Brief delivery: pre-generates prep briefs for every session before the
 *    next run (6.5h lookahead; idempotent, dedupes on existing briefs).
 */
export async function GET(request: NextRequest) {
  const unauthorized = verifyCronSecret(request);
  if (unauthorized) return unauthorized;

  const now = new Date();
  const errors: string[] = [];

  // One deadline for BOTH phases so calendar sync + brief delivery together stay
  // inside maxDuration. 270s leaves ~30s of the 300s cap for the response and
  // any in-flight request to unwind. Both phases stop starting new coaches past it.
  const deadline = Date.now() + 270_000;

  // 1. Calendar sync — a failure here must not block brief delivery.
  let calendarSync: Awaited<ReturnType<typeof syncCalendarSessions>> | null = null;
  try {
    const timeMin = new Date(now.getTime() - SYNC_LOOKBACK_HOURS * 60 * 60 * 1000);
    const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    calendarSync = await syncCalendarSessions(timeMin, timeMax, deadline);
    // Per-event failures are caught inside syncCalendarSessions and returned
    // in its errors array — surface them so a run where events failed to
    // persist doesn't report as a clean "completed".
    for (const eventError of calendarSync.errors) {
      errors.push(`calendar-sync: ${eventError}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Calendar sync failed:", message);
    errors.push(`calendar-sync: ${message}`);
  }

  // 2. Prep brief delivery
  let briefs: DeliverBriefsResult | null = null;
  try {
    briefs = await deliverDueBriefs(deadline);
    // Per-brief failures (LLM outage, revoked key) are collected inside
    // deliverDueBriefs — surface them like calendar-sync's per-event errors
    // so a run of total brief failure doesn't report as clean.
    for (const briefError of briefs.errors ?? []) {
      errors.push(`deliver-briefs: ${briefError}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Deliver briefs failed:", message);
    errors.push(`deliver-briefs: ${message}`);
  }

  const status = errors.length === 0 ? "completed" : "partial";
  // 500 only when every step failed — a partial success should still read
  // as a delivered cron run. Derived from the step results, not a count,
  // so adding a step can't silently break failure alerting.
  const allFailed = calendarSync === null && briefs === null;
  return NextResponse.json(
    {
      status,
      timestamp: now.toISOString(),
      calendarSync,
      briefs,
      ...(errors.length ? { errors } : {}),
    },
    { status: allFailed ? 500 : 200 }
  );
}
