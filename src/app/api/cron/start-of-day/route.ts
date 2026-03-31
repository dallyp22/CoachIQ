import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/cron/start-of-day — pre-generate the daily brief at 7 AM CT.
 * Calls /api/daily-brief so it's cached and ready when Todd opens the dashboard.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Trigger daily brief generation
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const resp = await fetch(`${baseUrl}/api/daily-brief?force=true`, {
      headers: request.headers,
    });

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
