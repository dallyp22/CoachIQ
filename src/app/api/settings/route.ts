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
