import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, clientWhere, authzResponse } from "@/lib/authz";

/**
 * GET /api/clients-list — lightweight client list for dropdowns.
 */
export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  const clients = await prisma.client.findMany({
    where: { status: { not: "CHURNED" }, ...clientWhere(coachId) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ clients });
}
