import { NextRequest, NextResponse } from "next/server";
import { requireCoach, scopeCoachId, authzResponse } from "@/lib/authz";
import { searchSessions } from "@/lib/search";

/**
 * POST /api/search — hybrid search across the caller's sessions.
 *
 * The pipeline itself lives in src/lib/search.ts (searchSessions) so the MCP
 * `search_sessions` tool runs the identical logic. This route only does the
 * HTTP + coach-scoping concerns.
 *
 * Search ranks across every transcript in scope — without a coach scope a COACH
 * would surface another coach's confidential session content, so scoping is
 * mandatory here.
 */
export async function POST(request: NextRequest) {
  let coach;
  try {
    coach = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  const { query, clientId, coachId: requestedCoachId, limit = 15 } = await request.json();
  const coachId = scopeCoachId(coach, requestedCoachId);

  const { results, method } = await searchSessions({ coachId, query, clientId, limit });
  return NextResponse.json({ results, method });
}
