import crypto from "crypto";

/**
 * Fathom external API + webhook signature verification.
 *
 * Webhooks follow the Standard Webhooks scheme: three headers (webhook-id,
 * webhook-timestamp, webhook-signature) and an HMAC-SHA256 over
 * "{id}.{timestamp}.{raw body}" keyed by the base64 secret that Fathom
 * returns at registration time, minus its "whsec_" prefix.
 */

const API_BASE = "https://api.fathom.ai/external/v1";
const REQUEST_TIMEOUT_MS = 15_000;

/** Replay window. Fathom retries, so this is tolerance, not a guarantee. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Only the recordings the key's own user made.
 *
 * On a Team plan the alternatives (shared_team_recordings,
 * my_shared_with_team_recordings) would deliver one meeting to BOTH coaches'
 * webhooks. Each would verify against its own secret, and the meeting would
 * be ingested twice under two different clients, with two billable time
 * entries. Pinning this is the difference between one invoice and two.
 */
export const TRIGGERED_FOR = ["my_recordings"] as const;

export type FathomWebhook = {
  id: string;
  url: string;
  secret: string;
};

export class FathomApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "FathomApiError";
  }
}

/**
 * Register a webhook for one coach and return its id and signing secret.
 *
 * The caller must persist BOTH: the secret authenticates incoming payloads,
 * and the id is the only way to know a webhook already exists — the API
 * exposes create and delete but no list.
 */
export async function registerWebhook(
  apiKey: string,
  destinationUrl: string
): Promise<FathomWebhook> {
  const res = await fathomFetch(apiKey, "/webhooks", {
    method: "POST",
    body: JSON.stringify({
      destination_url: destinationUrl,
      triggered_for: TRIGGERED_FOR,
      include_transcript: true,
      include_summary: true,
      include_action_items: true,
    }),
  });

  const data = (await res.json()) as Partial<FathomWebhook>;
  if (!data.id || !data.secret) {
    throw new FathomApiError("Fathom created a webhook but returned no id or secret.");
  }
  return { id: data.id, url: data.url ?? destinationUrl, secret: data.secret };
}

/** Remove a webhook — used when rotating a coach's key or deactivating them. */
export async function deleteWebhook(apiKey: string, webhookId: string): Promise<void> {
  await fathomFetch(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
}

async function fathomFetch(apiKey: string, path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      // Without a deadline a hung connection stalls the Add Coach request
      // until the platform kills the whole function.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    throw new FathomApiError(`Could not reach the Fathom API: ${reason}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FathomApiError(
      res.status === 401
        ? "Fathom rejected the API key."
        : `Fathom API error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      res.status
    );
  }
  return res;
}

// ─── Webhook verification ─────────────────────────────

export type SignatureHeaders = {
  webhookId: string;
  timestamp: string;
  signature: string;
};

export function readSignatureHeaders(headers: Headers): SignatureHeaders | null {
  const webhookId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!webhookId || !timestamp || !signature) return null;
  return { webhookId, timestamp, signature };
}

/** Is the timestamp inside the replay window? Checked once, before trying any secret. */
export function isTimestampFresh(timestamp: string, now: number = Date.now()): boolean {
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  return Math.abs(now / 1000 - ts) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/**
 * Verify a payload against ONE coach's secret.
 *
 * Returns a boolean rather than throwing: the caller may legitimately try a
 * second candidate secret when routing by sender email finds no coach.
 */
export function verifySignature(
  payload: Buffer,
  { webhookId, timestamp, signature }: SignatureHeaders,
  secret: string
): boolean {
  if (!secret) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  if (key.length === 0) return false;

  const signedContent = Buffer.concat([
    Buffer.from(`${webhookId}.${timestamp}.`),
    payload,
  ]);
  const expected = crypto.createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // The header may carry several space-separated signatures, each optionally
  // prefixed with a version ("v1,<sig>").
  for (const candidate of signature.split(" ")) {
    const parts = candidate.split(",");
    const value = parts[parts.length - 1];
    if (!value) continue;
    const valueBuf = Buffer.from(value);
    // timingSafeEqual THROWS on a length mismatch, so the length check has to
    // come first — a wrong-length signature must be a plain false, not a 500.
    if (valueBuf.length === expectedBuf.length && crypto.timingSafeEqual(valueBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

// ─── Payload helpers ──────────────────────────────────

export type FathomUser = {
  name?: string;
  email?: string;
  team?: string;
  email_domain?: string;
};

/**
 * The address that recorded the meeting, used to route the payload to a coach
 * BEFORE any signature has been checked.
 *
 * This is an untrusted hint and nothing more: it selects which secret to try,
 * and the HMAC decides whether the payload is genuine. A forged recorded_by
 * only picks a secret the forger still cannot produce a signature for.
 */
export function recorderEmail(body: { recorded_by?: FathomUser }): string | null {
  const email = body?.recorded_by?.email;
  return typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : null;
}
