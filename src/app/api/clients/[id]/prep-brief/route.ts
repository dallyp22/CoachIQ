import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generatePrepBrief } from "@/lib/prep-brief";

/**
 * POST /api/clients/[id]/prep-brief — generate a new prep brief
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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
  const { id } = await params;

  const brief = await prisma.prepBrief.findFirst({
    where: { clientId: id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ brief: brief || null });
}
