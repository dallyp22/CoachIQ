import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Update client profile.
 * PATCH /api/clients/[id]
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const allowedFields = [
    "name", "email", "phone", "company", "hourlyRate",
    "billingCadence", "meetingCadence", "status", "notes", "tags",
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      if (field === "hourlyRate") {
        updates[field] = parseFloat(body[field]);
      } else {
        updates[field] = body[field];
      }
    }
  }

  const updated = await prisma.client.update({
    where: { id },
    data: updates,
  });

  return NextResponse.json({ status: "updated", client: updated });
}

/**
 * Archive (soft delete) a client.
 * DELETE /api/clients/[id]
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  await prisma.client.update({
    where: { id },
    data: { status: "CHURNED" },
  });

  return NextResponse.json({ status: "archived" });
}
