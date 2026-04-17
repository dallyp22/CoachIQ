import { NextRequest, NextResponse } from "next/server";
import { generateForAllDueClients } from "@/lib/billing/generate";

/**
 * GET /api/cron/invoice-generation
 *
 * Daily cron (vercel.json: "0 13 * * *" = 7am CT in winter / 8am DT in summer).
 * Iterates active clients, generates draft (or APPROVED if under threshold)
 * invoices for any whose nextInvoiceDueAt has elapsed.
 *
 * Per-client logic lives in src/lib/billing/generate.ts and is shared with
 * the manual "Generate Draft Invoices" button in /api/invoices/generate.
 *
 * Cron-header auth: Vercel sets Authorization: Bearer ${CRON_SECRET} on
 * scheduled invocations. Returns 401 otherwise (when CRON_SECRET is set).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
