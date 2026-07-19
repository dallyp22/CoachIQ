import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";

/**
 * GET /api/cron/start-of-day — intended to pre-generate the daily brief at
 * the start of the workday.
 *
 * CURRENTLY UNSCHEDULED (removed from vercel.json): /api/daily-brief is
 * Clerk-protected, so this route's server-to-server fetch has always been
 * redirected to sign-in and failed — and there is no cache for a pre-warm
 * to fill anyway. Re-schedule only after daily-brief gets cron auth and a
 * real cache (see TODOS.md "Daily-brief pre-warm").
 */
export async function GET(request: NextRequest) {
  const unauthorized = verifyCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    // Trigger daily brief generation. NEXT_PUBLIC_APP_URL wins when set
    // (it's a full URL); otherwise fall back to the deployment URL.
    // || (not ??) so a set-but-empty env var — a common `vercel env pull`
    // artifact — falls through instead of producing an unparseable "" URL.
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000");

    // No headers forwarded: daily-brief never reads cron auth, so sending
    // Bearer ${CRON_SECRET} to whatever host baseUrl resolves to was pure
    // leak surface with zero function.
    const resp = await fetch(`${baseUrl}/api/daily-brief?force=true`);

    const data = await resp.json();

    return NextResponse.json({
      status: "completed",
      timestamp: new Date().toISOString(),
      sessions: data.sessions?.length || 0,
      briefGenerated: data.status === "generated" || data.status === "no_sessions",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Start-of-day cron failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
