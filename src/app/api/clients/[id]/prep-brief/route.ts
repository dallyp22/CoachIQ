import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generatePrepBrief } from "@/lib/prep-brief";
import {
  requireCoach,
  scopeCoachId,
  canAccess,
  viaClientWhere,
  authzResponse,
} from "@/lib/authz";

/**
 * POST /api/clients/[id]/prep-brief — generate a new prep brief
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await params;

  const client = await prisma.client.findUnique({
    where: { id },
    select: { coachId: true },
  });
  if (!client || !canAccess(coachId, client.coachId)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  try {
    const brief = await generatePrepBrief(id);
    return NextResponse.json({ status: "generated", brief });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate brief";
    console.error("Prep brief error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/clients/[id]/prep-brief — get the latest prep brief
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await params;

  // Scoping through `client` rather than a separate existence check keeps the
  // response for another coach's client identical to "no brief yet".
  const brief = await prisma.prepBrief.findFirst({
    where: { clientId: id, ...viaClientWhere(coachId) },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ brief: brief || null });
}
