import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "@/lib/db";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { nextCadenceDate, type CadenceOpts } from "@/lib/billing/cadence";
import { requireCoach, scopeCoachId, canAccess, authzResponse } from "@/lib/authz";

/**
 * Update client profile.
 * PATCH /api/clients/[id]
 *
 * Accepts both general profile fields and the new billing fields added in
 * the billing-overhaul migration. Recomputes nextInvoiceDueAt when cadence
 * or customCadenceDays changes. Audit-logs money-relevant edits.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, null);
  } catch (err) {
    return authzResponse(err);
  }
  // Audit rows record the Clerk account that acted, not the coach it resolves to.
  const { userId } = await auth();

  const { id } = await params;
  const body = await request.json();

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client || !canAccess(coachId, client.coachId)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const allowedFields = [
    // Profile
    "name", "email", "phone", "company", "status", "notes", "tags", "allowsFathom",
    "meetingCadence",
    // Billing identity
    "displayName", "billingContactName", "billingContactEmail", "secondaryEmails",
    // Billing cadence + rates
    "hourlyRate", "billingCadence", "customCadenceDays", "billingTimezone",
    // Billing state
    "billingPausedUntil", "billingNotes", "retainer",
  ] as const;

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] === undefined) continue;
    const v = body[field];

    if (field === "hourlyRate" || field === "retainer") {
      try {
        updates[field] = new Decimal(v);
      } catch {
        return NextResponse.json(
          { error: `Invalid number for ${field}` },
          { status: 400 },
        );
      }
    } else if (field === "allowsFathom") {
      updates[field] = Boolean(v);
    } else if (field === "customCadenceDays") {
      if (v === null || v === "") {
        updates[field] = null;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          return NextResponse.json(
            { error: "customCadenceDays must be an integer between 1 and 365" },
            { status: 400 },
          );
        }
        updates[field] = n;
      }
    } else if (field === "billingPausedUntil") {
      updates[field] = v ? new Date(v) : null;
    } else if (field === "displayName" || field === "billingContactName" || field === "billingContactEmail" || field === "billingNotes" || field === "billingTimezone") {
      // Empty string → null so optional text fields don't store ""
      updates[field] = v === "" ? null : v;
    } else if (field === "secondaryEmails" || field === "tags") {
      updates[field] = Array.isArray(v) ? v : [];
    } else {
      updates[field] = v;
    }
  }

  // Recompute nextInvoiceDueAt if cadence-relevant fields changed.
  const cadenceChanged =
    updates.billingCadence !== undefined ||
    updates.customCadenceDays !== undefined ||
    updates.billingTimezone !== undefined;

  if (cadenceChanged) {
    const settings = await prisma.coachSettings.findFirst();
    const newCadence = (updates.billingCadence as typeof client.billingCadence) ?? client.billingCadence;
    const newCustomDays = updates.customCadenceDays !== undefined
      ? (updates.customCadenceDays as number | null)
      : client.customCadenceDays;
    const tz = (updates.billingTimezone as string | null) ?? client.billingTimezone ?? settings?.timezone ?? "America/Chicago";

    const cadenceOpts: CadenceOpts = {
      cadence: newCadence,
      customCadenceDays: newCustomDays,
      defaultBillingDayOfMonth: settings?.defaultBillingDayOfMonth ?? null,
      timezone: tz,
    };

    try {
      updates.nextInvoiceDueAt = nextCadenceDate(new Date(), cadenceOpts);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid cadence" },
        { status: 400 },
      );
    }
  }

  // Detect retainer add separately (audit it as RETAINER_ADD, not MANUAL_EDIT)
  const retainerAdded =
    updates.retainer !== undefined &&
    (updates.retainer as Decimal).greaterThan(client.retainer);

  // Detect cadence change for separate audit
  const cadenceEvent =
    updates.billingCadence !== undefined && updates.billingCadence !== client.billingCadence;

  // Detect any money-relevant edit
  const moneyFields = ["hourlyRate", "billingCadence", "customCadenceDays", "displayName", "billingContactEmail", "secondaryEmails", "billingPausedUntil"];
  const moneyEdited = moneyFields.some((f) => updates[f] !== undefined);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.client.update({ where: { id }, data: updates });

      if (retainerAdded) {
        const delta = (updates.retainer as Decimal).minus(client.retainer);
        await logEvent(tx, {
          event: BillingEvent.RETAINER_ADD,
          actor: userId,
          clientId: id,
          payload: { added: Number(delta), newBalance: Number(updates.retainer as Decimal) },
        });
      } else if (cadenceEvent) {
        await logEvent(tx, {
          event: BillingEvent.CADENCE_CHANGE,
          actor: userId,
          clientId: id,
          payload: {
            from: client.billingCadence,
            to: updates.billingCadence,
            customDays: updates.customCadenceDays,
          },
        });
      } else if (moneyEdited) {
        await logEvent(tx, {
          event: BillingEvent.MANUAL_EDIT,
          actor: userId,
          clientId: id,
          payload: { changedFields: Object.keys(updates).filter((k) => moneyFields.includes(k)) },
        });
      }

      return u;
    });

    return NextResponse.json({ status: "updated", client: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Archive (soft delete) a client.
 * DELETE /api/clients/[id]
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

  await prisma.client.update({
    where: { id },
    data: { status: "CHURNED" },
  });

  return NextResponse.json({ status: "archived" });
}
