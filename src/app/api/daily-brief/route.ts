import { NextRequest, NextResponse } from "next/server";
import { requireCoach, scopeCoachId, authzResponse } from "@/lib/authz";
import { buildDailyBrief } from "@/lib/daily-brief";

/**
 * GET /api/daily-brief — generate today's morning brief.
 *
 * The assembly (calendar → clients → AI) lives in buildDailyBrief() in
 * src/lib/daily-brief.ts so the MCP get_daily_brief tool produces the identical
 * brief. This route handles HTTP + coach scoping only.
 *
 * The daily brief is one coach's day: their calendar + their clients. An
 * OWNER/ADMIN with no ?coachId gets their OWN brief (not a practice-wide merge),
 * and may pass ?coachId=<other> to view another coach's day.
 */
export async function GET(request: NextRequest) {
  let briefCoachId: string;
  try {
    const coach = await requireCoach();
    const coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
    briefCoachId = coachId ?? coach.id;
  } catch (err) {
    return authzResponse(err);
  }

  try {
    const result = await buildDailyBrief(briefCoachId);
    if (result.status === "no_calendar") {
      return NextResponse.json({ error: "Google Calendar not configured" }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Daily brief error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
