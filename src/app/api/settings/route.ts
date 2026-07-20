import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { encryptSecret, isEncrypted } from "@/lib/secrets";
import { maskCoachSecret, isMasked } from "@/lib/coach-secrets";

/**
 * GET /api/settings — fetch practice settings.
 *
 * ADMIN and above only. This is practice-level configuration — Stripe,
 * AI keys, invoice numbering — not per-coach profile, so a COACH has no
 * business reading it even masked. (Per-coach self-serve settings are a
 * separate, later surface.)
 */
export async function GET() {
  try {
    await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

  let settings = await prisma.coachSettings.findFirst();
  if (!settings) {
    settings = await prisma.coachSettings.create({ data: {} });
  }

  // Mask every secret column for display (last 4 chars of the real key only).
  // maskCoachSecret decrypts first, so the mask reflects the key, not the
  // ciphertext. These overrides must cover EVERY secret column, or the
  // `...settings` spread above would emit a raw secret to the client.
  return NextResponse.json({
    ...settings,
    defaultHourlyRate: Number(settings.defaultHourlyRate),
    openaiApiKey: maskCoachSecret(settings.openaiApiKey),
    anthropicApiKey: maskCoachSecret(settings.anthropicApiKey),
    stripeSecretKey: maskCoachSecret(settings.stripeSecretKey),
    fathomWebhookSecret: maskCoachSecret(settings.fathomWebhookSecret),
  });
}

/**
 * PATCH /api/settings — update coach settings
 */
export async function PATCH(request: NextRequest) {
  try {
    await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

  const body = await request.json();

  let settings = await prisma.coachSettings.findFirst();
  if (!settings) {
    settings = await prisma.coachSettings.create({ data: {} });
  }

  const updates: Record<string, unknown> = {};

  const textFields = [
    "coachName", "coachEmail", "businessName", "googleCalendarId",
    "coachingTitleFilter",
  ];
  for (const field of textFields) {
    if (body[field] !== undefined) updates[field] = body[field] || null;
  }

  // Secret columns — encrypted at rest via src/lib/secrets.ts. Only update when
  // a NEW value is provided: the GET response hands back a "•••1234" mask for
  // untouched fields, and isMasked() guards against re-encrypting that mask AS
  // the key. fathomWebhookSecret is a real signing secret and is protected the
  // same way (it must never round-trip in the clear). encryptSecret throws when
  // COACHIQ_SECRETS_KEY is missing/invalid — return a structured 500 rather
  // than an opaque unhandled throw, matching the endpoint's other error shapes.
  const SECRET_FIELDS = [
    "openaiApiKey", "anthropicApiKey", "stripeSecretKey", "fathomWebhookSecret",
  ] as const;
  try {
    for (const field of SECRET_FIELDS) {
      const value = body[field];
      // Encrypt only a genuine new plaintext string. The typeof guard keeps a
      // non-string payload from reaching encryptSecret (whose input error would
      // be mislabeled by the catch below as a key-config 500). Skip the mask
      // (unchanged field) and any value already in envelope form (an admin
      // re-submitting ciphertext) — the isEncrypted guard mirrors the backfill
      // and stops a double-encryption that would decrypt to a "v1:…" key.
      if (typeof value === "string" && value && !isMasked(value) && !isEncrypted(value)) {
        updates[field] = encryptSecret(value);
      }
    }
  } catch {
    return NextResponse.json(
      { error: "Secrets key is not configured — cannot save API keys." },
      { status: 500 },
    );
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
      openaiApiKey: maskCoachSecret(updated.openaiApiKey),
      anthropicApiKey: maskCoachSecret(updated.anthropicApiKey),
      stripeSecretKey: maskCoachSecret(updated.stripeSecretKey),
      fathomWebhookSecret: maskCoachSecret(updated.fathomWebhookSecret),
    },
  });
}
