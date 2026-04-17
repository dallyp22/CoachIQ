import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "@/lib/db";
import { nextCadenceDate, type CadenceOpts } from "@/lib/billing/cadence";
import type { BillingCadence } from "@/generated/prisma/client";

/**
 * GET /api/clients/[id]/billing-preview?cadence=MONTHLY&customDays=14
 *
 * Live computation of "next invoice fires when, for ~$X" used by the Billing
 * tab's preview strip. Recomputes whenever Todd flips a cadence-relevant
 * dropdown (debounced 250ms client-side) so the consequence is visceral.
 *
 * Query params override the stored values so the user sees what the next
 * invoice would look like under the *proposed* settings, not the saved ones.
 *
 * Returns:
 *   {
 *     nextDate: ISO string,
 *     unbilledHours: number,
 *     estimatedSubtotal: number,
 *     retainerToApply: number,
 *     estimatedTotal: number,
 *     paused: boolean,
 *     pausedUntil: ISO string | null
 *   }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const url = new URL(request.url);
  const cadenceParam = url.searchParams.get("cadence") as BillingCadence | null;
  const customDaysParam = url.searchParams.get("customDays");
  const dayOfMonthParam = url.searchParams.get("dayOfMonth");

  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      timeEntries: {
        where: { status: "UNBILLED" },
        select: { billableHours: true, hourlyRate: true, amount: true },
      },
    },
  });
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const settings = await prisma.coachSettings.findFirst();

  const now = new Date();
  const paused =
    !!client.billingPausedUntil && client.billingPausedUntil.getTime() > now.getTime();

  const cadence = cadenceParam ?? client.billingCadence;
  const customCadenceDays = customDaysParam
    ? parseInt(customDaysParam, 10)
    : client.customCadenceDays;
  const defaultBillingDayOfMonth = dayOfMonthParam
    ? parseInt(dayOfMonthParam, 10)
    : settings?.defaultBillingDayOfMonth ?? null;
  const timezone =
    client.billingTimezone ?? settings?.timezone ?? "America/Chicago";

  const cadenceOpts: CadenceOpts = {
    cadence,
    customCadenceDays,
    defaultBillingDayOfMonth,
    timezone,
  };

  let nextDate: Date;
  try {
    nextDate = client.nextInvoiceDueAt && client.nextInvoiceDueAt.getTime() > now.getTime()
      ? client.nextInvoiceDueAt
      : nextCadenceDate(now, cadenceOpts);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid cadence" },
      { status: 400 },
    );
  }

  const unbilledHours = client.timeEntries.reduce(
    (sum, e) => sum + Number(e.billableHours),
    0,
  );
  const estimatedSubtotal = client.timeEntries.reduce(
    (sum, e) => sum.plus(e.amount),
    new Decimal(0),
  );
  const retainerToApply = Decimal.min(client.retainer, estimatedSubtotal);
  const estimatedTotal = estimatedSubtotal.minus(retainerToApply);

  return NextResponse.json({
    nextDate: nextDate.toISOString(),
    unbilledHours,
    estimatedSubtotal: Number(estimatedSubtotal),
    retainerToApply: Number(retainerToApply),
    estimatedTotal: Number(estimatedTotal),
    paused,
    pausedUntil: client.billingPausedUntil?.toISOString() ?? null,
    timezone,
  });
}
