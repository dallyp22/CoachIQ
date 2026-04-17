import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/settings — fetch coach settings
 */
export async function GET() {
  let settings = await prisma.coachSettings.findFirst();
  if (!settings) {
    settings = await prisma.coachSettings.create({ data: {} });
  }

  // Mask API keys for display (show last 4 chars only)
  return NextResponse.json({
    ...settings,
    defaultHourlyRate: Number(settings.defaultHourlyRate),
    openaiApiKey: maskKey(settings.openaiApiKey),
    anthropicApiKey: maskKey(settings.anthropicApiKey),
    stripeSecretKey: maskKey(settings.stripeSecretKey),
  });
}

/**
 * PATCH /api/settings — update coach settings
 */
export async function PATCH(request: NextRequest) {
  const body = await request.json();

  let settings = await prisma.coachSettings.findFirst();
  if (!settings) {
    settings = await prisma.coachSettings.create({ data: {} });
  }

  const updates: Record<string, unknown> = {};

  const textFields = [
    "coachName", "coachEmail", "businessName", "googleCalendarId",
    "fathomWebhookSecret", "coachingTitleFilter",
  ];
  for (const field of textFields) {
    if (body[field] !== undefined) updates[field] = body[field] || null;
  }

  // API keys — only update if a new value is provided (not the masked version)
  if (body.openaiApiKey && !body.openaiApiKey.startsWith("•••")) {
    updates.openaiApiKey = body.openaiApiKey;
  }
  if (body.anthropicApiKey && !body.anthropicApiKey.startsWith("•••")) {
    updates.anthropicApiKey = body.anthropicApiKey;
  }
  if (body.stripeSecretKey && !body.stripeSecretKey.startsWith("•••")) {
    updates.stripeSecretKey = body.stripeSecretKey;
  }

  if (body.defaultHourlyRate !== undefined) {
    updates.defaultHourlyRate = parseFloat(body.defaultHourlyRate);
  }
  if (body.defaultBillingCadence !== undefined) {
    updates.defaultBillingCadence = body.defaultBillingCadence;
  }
  if (body.briefDeliveryMinutes !== undefined) {
    updates.briefDeliveryMinutes = parseInt(body.briefDeliveryMinutes);
  }

  // New billing-overhaul fields
  if (body.defaultBillingDayOfMonth !== undefined) {
    if (body.defaultBillingDayOfMonth === null || body.defaultBillingDayOfMonth === "") {
      updates.defaultBillingDayOfMonth = null;
    } else {
      const n = Number(body.defaultBillingDayOfMonth);
      if (!Number.isInteger(n) || n < 1 || n > 28) {
        return NextResponse.json(
          { error: "defaultBillingDayOfMonth must be an integer between 1 and 28" },
          { status: 400 },
        );
      }
      updates.defaultBillingDayOfMonth = n;
    }
  }
  if (body.autoApproveUnderCents !== undefined) {
    if (body.autoApproveUnderCents === null || body.autoApproveUnderCents === "") {
      updates.autoApproveUnderCents = null;
    } else {
      const n = Number(body.autoApproveUnderCents);
      if (!Number.isInteger(n) || n < 0) {
        return NextResponse.json(
          { error: "autoApproveUnderCents must be a non-negative integer" },
          { status: 400 },
        );
      }
      updates.autoApproveUnderCents = n;
    }
  }
  if (body.invoicePrefix !== undefined) {
    const v = String(body.invoicePrefix).trim();
    if (v.length === 0 || v.length > 8) {
      return NextResponse.json(
        { error: "invoicePrefix must be 1-8 characters" },
        { status: 400 },
      );
    }
    updates.invoicePrefix = v;
  }
  if (body.invoiceNumberPadding !== undefined) {
    const n = Number(body.invoiceNumberPadding);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return NextResponse.json(
        { error: "invoiceNumberPadding must be an integer between 1 and 10" },
        { status: 400 },
      );
    }
    updates.invoiceNumberPadding = n;
  }
  if (body.timezone !== undefined) {
    const v = String(body.timezone).trim();
    if (v.length === 0) {
      return NextResponse.json({ error: "timezone is required" }, { status: 400 });
    }
    updates.timezone = v;
  }

  const updated = await prisma.coachSettings.update({
    where: { id: settings.id },
    data: updates,
  });

  return NextResponse.json({
    status: "updated",
    settings: {
      ...updated,
      defaultHourlyRate: Number(updated.defaultHourlyRate),
      openaiApiKey: maskKey(updated.openaiApiKey),
      anthropicApiKey: maskKey(updated.anthropicApiKey),
      stripeSecretKey: maskKey(updated.stripeSecretKey),
    },
  });
}

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return "•••" + key.slice(-4);
}
