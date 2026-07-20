import { NextRequest, NextResponse } from "next/server";
import { syncCalendarSessions } from "@/lib/calendar-sync";
import { requireCoach, authzResponse } from "@/lib/authz";

/**
 * POST /api/calendar/sync — manually trigger calendar sync.
 *
 * Query params:
 *   days=14  — number of days to sync (past + future, default 14)
 */
export async function POST(request: NextRequest) {
  // No auth check existed here at all — the only gate was Clerk's presence
  // check in middleware, so any signed-in account could run a practice-wide
  // sync. syncCalendarSessions writes Sessions across every coach's clients,
  // so this is ADMIN until sync itself iterates coaches.
  try {
    await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

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
