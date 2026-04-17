import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { generateForAllDueClients } from "@/lib/billing/generate";

/**
 * POST /api/invoices/generate
 *
 * Manual "Generate Draft Invoices" button on /invoices. Iterates active
 * clients and generates drafts for any with unbilled work, regardless of
 * cadence schedule (`ignoreSchedule: true`).
 *
 * Per-client logic and the race-free invoice number sequence both live in
 * src/lib/billing/generate.ts — the cron at /api/cron/invoice-generation
 * uses the same code path with `ignoreSchedule: false`.
 *
 * Idempotent at the per-client level via the Postgres advisory lock acquired
 * inside `generateInvoiceForClient`, so concurrent clicks (or a cron run
 * happening in the same minute) won't produce duplicate invoices.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await generateForAllDueClients({
      source: "manual",
      actor: userId,
      ignoreSchedule: true,
    });

    return NextResponse.json({
      created: result.created,
      total: result.total,
      skipped: result.skipped,
      errors: result.errors,
      message:
        result.created > 0
          ? `${result.created} draft invoice${result.created === 1 ? "" : "s"} generated`
          : "No unbilled time entries to invoice",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    console.error("[manual generate] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
