import { NextRequest, NextResponse } from "next/server";

/**
 * Verify the Vercel cron secret on a scheduled invocation.
 * Vercel sets Authorization: Bearer ${CRON_SECRET} on cron requests.
 * Returns an error response to send back, or null when the request is
 * authorized.
 *
 * Fails CLOSED when CRON_SECRET is missing on Vercel: without it these
 * endpoints would be publicly invocable (invoice generation, paid LLM
 * calls). Local dev (no VERCEL env) stays open for convenience.
 */
export function verifyCronSecret(request: NextRequest): NextResponse | null {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    if (process.env.VERCEL) {
      console.error("CRON_SECRET is not set — rejecting cron request");
      return NextResponse.json(
        { error: "Cron secret not configured" },
        { status: 503 }
      );
    }
    return null;
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
