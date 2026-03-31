import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/clients-list — lightweight client list for dropdowns.
 */
export async function GET() {
  const clients = await prisma.client.findMany({
    where: { status: { not: "CHURNED" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ clients });
}
