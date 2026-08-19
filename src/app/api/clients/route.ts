import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { createClients, type ClientInput } from "@/lib/clients";

/**
 * POST /api/clients — add one client, or a batch.
 *
 * The create/validate/dedup logic lives in src/lib/clients.ts (createClients)
 * so the MCP `create_client` tool runs the identical logic. This route only
 * handles the HTTP shape and deciding whose book the clients land in.
 *
 * Body: a single client object, or `{ clients: [...] }` for a batch — a roster
 * gets entered in one sitting during onboarding, not one at a time.
 */
export async function POST(request: NextRequest) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  const body = await request.json();
  const rows: ClientInput[] = Array.isArray(body?.clients)
    ? body.clients
    : Array.isArray(body)
      ? body
      : [body];

  if (rows.length === 0) {
    return NextResponse.json({ error: "No clients supplied" }, { status: 400 });
  }

  // Which coach's book do these land in? A COACH may only add to their own —
  // taking coachId from the request body would reopen the hole every scoped
  // read was just closed against. OWNER/ADMIN may add on a coach's behalf.
  let coachId = actor.id;
  if (actor.role !== "COACH" && typeof body?.coachId === "string" && body.coachId) {
    const target = await prisma.coach.findUnique({
      where: { id: body.coachId },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ error: "Coach not found" }, { status: 404 });
    }
    coachId = target.id;
  }

  const { created, failed } = await createClients(coachId, rows);

  // A partially-successful batch reports both halves rather than failing whole:
  // re-pasting a 30-client roster to fix one typo is miserable.
  const status = created.length === 0 ? 400 : failed.length > 0 ? 207 : 201;
  return NextResponse.json({ created, failed }, { status });
}
