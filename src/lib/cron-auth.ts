import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Verify the Vercel cron secret on a scheduled invocation.
 * Vercel sets Authorization: Bearer ${CRON_SECRET} on cron requests.
 * Returns an error response to send back, or null when the request is
 * authorized.
 *
 * Fails CLOSED when CRON_SECRET is missing in any production context
 * (Vercel, or NODE_ENV=production on any other host): without it these
 * endpoints would be publicly invocable (invoice generation, paid LLM
 * calls). Only true local dev stays open for convenience.
 */
export function verifyCronSecret(request: NextRequest): NextResponse | null {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      console.error("CRON_SECRET is not set — rejecting cron request");
      return NextResponse.json(
        { error: "Cron secret not configured" },
        { status: 503 }
      );
    }
    return null;
  }
  // Constant-time comparison: hashing both sides to equal-length digests
  // lets timingSafeEqual run without leaking length or prefix information —
  // this token check is the only auth gate on these public endpoints.
  const expected = createHash("sha256").update(`Bearer ${cronSecret}`).digest();
  const presented = createHash("sha256").update(authHeader ?? "").digest();
  if (!timingSafeEqual(expected, presented)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
