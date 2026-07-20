import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { requireCoach, scopeCoachId, authzResponse } from "@/lib/authz";
import { Decimal } from "@prisma/client/runtime/client";

/**
 * GET /api/billing-groups — list groups with member counts and a peek at
 * the next-invoice preview (sum of unbilled hours across members).
 */
export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  // BillingGroup owns a coachId column directly — no hop through `client`.
  const groups = await prisma.billingGroup.findMany({
    where: coachId ? { coachId } : {},
    orderBy: { name: "asc" },
    include: {
      _count: { select: { members: true, invoices: true } },
    },
  });

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
      billingContactEmail: g.billingContactEmail,
      billingCadence: g.billingCadence,
      nextInvoiceDueAt: g.nextInvoiceDueAt,
      retainer: Number(g.retainer),
      hourlyRate: g.hourlyRate ? Number(g.hourlyRate) : null,
      status: g.status,
      memberCount: g._count.members,
      invoiceCount: g._count.invoices,
    })),
  );
}

/**
 * POST /api/billing-groups — create a new group.
 */
export async function POST(request: NextRequest) {
  let actingCoach;
  try {
    actingCoach = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }
  // Audit rows record the Clerk account that acted, not the coach it resolves to.
  const { userId } = await auth();

  const body = await request.json();

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (
    typeof body.billingContactEmail !== "string" ||
    !body.billingContactEmail.includes("@")
  ) {
    return NextResponse.json(
      { error: "billingContactEmail is required and must look like an email" },
      { status: 400 },
    );
  }

  // Every group belongs to exactly one coach, and every member client must
  // share it (enforced at member-add). A coach creating a group owns it —
  // attributing it to the practice owner would make the group invisible to
  // its creator and reject their own clients as members. OWNER/ADMIN may
  // create one on another coach's behalf by naming them.
  const coachId =
    actingCoach.role !== "COACH" && typeof body.coachId === "string" && body.coachId
      ? body.coachId
      : actingCoach.id;

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.billingGroup.create({
      data: {
        coachId,
        name: body.name.trim(),
        displayName: body.displayName?.trim() || null,
        billingContactName: body.billingContactName?.trim() || null,
        billingContactEmail: body.billingContactEmail.trim(),
        ccEmails: Array.isArray(body.ccEmails)
          ? body.ccEmails.filter((e: unknown) => typeof e === "string" && e.includes("@"))
          : [],
        hourlyRate:
          body.hourlyRate !== undefined && body.hourlyRate !== null && body.hourlyRate !== ""
            ? new Decimal(body.hourlyRate)
            : null,
        billingCadence: body.billingCadence ?? "MONTHLY",
        customCadenceDays: body.customCadenceDays ?? null,
        billingTimezone: body.billingTimezone ?? null,
        notes: body.notes ?? null,
        tags: Array.isArray(body.tags) ? body.tags : [],
      },
    });
    await logEvent(tx, {
      event: BillingEvent.GROUP_CREATED,
      actor: userId,
      groupId: created.id,
      payload: { name: created.name },
    });
    return created;
  });

  return NextResponse.json({ id: group.id, status: "created" }, { status: 201 });
}
