import { NextRequest, NextResponse } from "next/server";
import { syncCalendarSessions } from "@/lib/calendar-sync";

/**
 * GET /api/cron/calendar-sync — Vercel cron job for calendar sync.
 * Runs every 15 minutes, syncs past 24h + next 24h.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const result = await syncCalendarSessions(timeMin, timeMax);

    return NextResponse.json({
      status: "synced",
      timestamp: now.toISOString(),
      ...result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Calendar sync cron failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
