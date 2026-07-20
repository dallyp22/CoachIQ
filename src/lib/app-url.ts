/**
 * The app's own public base URL.
 *
 * NEXT_PUBLIC_APP_URL wins when set (it is a full URL); otherwise fall back to
 * the deployment URL. `||` rather than `??` on purpose: a set-but-empty env
 * var is a common `vercel env pull` artifact and must fall through instead of
 * producing an unparseable "" URL.
 */
export function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

/**
 * Where Fathom should deliver a coach's recordings.
 *
 * Refuses to guess in production. VERCEL_URL is the immutable per-deployment
 * hostname, which sits behind Deployment Protection — a webhook registered
 * against it receives an auth page instead of this handler, and every
 * recording for that coach is silently lost. Fathom has no list endpoint, so
 * the only handle on such a webhook is the id we stored.
 *
 * Failing the Add Coach request is recoverable. A webhook pointed at a dead
 * URL is not obviously anything, until someone notices a coach has no
 * sessions.
 */
export function fathomWebhookUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured && (process.env.VERCEL || process.env.NODE_ENV === "production")) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not set, so there is no stable public URL to register a Fathom " +
        "webhook against. Set it to the address Fathom can actually reach before adding a coach."
    );
  }
  return `${configured || appBaseUrl()}/api/webhook/fathom`;
}
