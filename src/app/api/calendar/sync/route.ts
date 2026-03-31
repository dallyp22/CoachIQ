import { NextRequest, NextResponse } from "next/server";
import { syncCalendarSessions } from "@/lib/calendar-sync";

/**
 * POST /api/calendar/sync — manually trigger calendar sync.
 *
 * Query params:
 *   days=14  — number of days to sync (past + future, default 14)
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "14", 10);
    const halfDays = Math.ceil(days / 2);

    const now = new Date();
    const timeMin = new Date(now.getTime() - halfDays * 24 * 60 * 60 * 1000);
    const timeMax = new Date(now.getTime() + halfDays * 24 * 60 * 60 * 1000);

    const result = await syncCalendarSessions(timeMin, timeMax);

    return NextResponse.json({
      status: "synced",
      ...result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
