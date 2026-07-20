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

/** Where Fathom should deliver a coach's recordings. */
export function fathomWebhookUrl(): string {
  return `${appBaseUrl()}/api/webhook/fathom`;
}
