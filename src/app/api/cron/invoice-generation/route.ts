import { NextRequest, NextResponse } from "next/server";
import { generateForAllDueClients } from "@/lib/billing/generate";
import { verifyCronSecret } from "@/lib/cron-auth";

/**
 * GET /api/cron/invoice-generation
 *
 * Weekday cron (vercel.json: "5 12 * * 1-5" = 7:05am CDT / 6:05am CST —
 * inside the workday-sync Neon wake window). Weekdays-only on purpose:
 * calendar sync doesn't run on weekends, so a Sat/Sun run would invoice
 * against up to 66h of unsynced Friday sessions. Clients due on a weekend
 * are picked up Monday 12:05, right after the backlog sync.
 * Iterates active clients, generates draft (or APPROVED if under threshold)
 * invoices for any whose nextInvoiceDueAt has elapsed.
 *
 * Per-client logic lives in src/lib/billing/generate.ts and is shared with
 * the manual "Generate Draft Invoices" button in /api/invoices/generate.
 *
 * Cron-header auth: Vercel sets Authorization: Bearer ${CRON_SECRET} on
 * scheduled invocations. Wrong/missing token returns 401; a missing
 * CRON_SECRET fails closed with 503 on Vercel (open in local dev).
 */
export async function GET(request: NextRequest) {
  const unauthorized = verifyCronSecret(request);
  if (unauthorized) return unauthorized;

  const startedAt = new Date();
  try {
    const result = await generateForAllDueClients({ source: "cron", actor: null });
    return NextResponse.json({
      ok: true,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[invoice-generation cron] error:", message);
    return NextResponse.json(
      {
        ok: false,
        startedAt: startedAt.toISOString(),
        error: message,
      },
      { status: 500 },
    );
  }
}
