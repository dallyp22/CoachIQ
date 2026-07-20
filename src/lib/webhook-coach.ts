import { prisma } from "@/lib/db";
import { decryptOptional } from "@/lib/secrets";
import { verifySignature, type SignatureHeaders } from "@/lib/fathom";

/**
 * Decide which coach an incoming Fathom payload belongs to, and prove it.
 *
 *   recorded_by.email ──► coach whose workEmails contain it   (ROUTING HINT)
 *          │                        │
 *          │ no match               ▼ verify HMAC vs THAT coach's secret only
 *          ▼                        └─► pass: authenticated · fail: reject, named
 *   try every configured coach's secret in turn (fallback)
 *          └─► whichever verifies IS the sender · none verify: reject
 *
 * The hint is untrusted — it only chooses which secret to try. The HMAC is
 * what authenticates. A forged recorded_by merely selects a secret the forger
 * still cannot sign with.
 *
 * Routing by sender first (rather than always iterating) means a failure is
 * attributable: "Kurt's secret did not verify" instead of "something didn't
 * match anything", which is the difference between a fixable alert and a
 * mystery 401.
 */

export type CoachIdentity = {
  id: string;
  name: string;
  loginEmail: string;
  workEmails: string[];
  coachingTitleFilter: string | null;
  driveRootFolderId: string | null;
};

export type ResolveOutcome =
  | { ok: true; coach: CoachIdentity; matchedBy: "sender" | "fallback" }
  | { ok: false; reason: "no_coaches_configured" | "sender_secret_mismatch" | "no_secret_matched"; senderEmail: string | null; coachName?: string };

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  loginEmail: true,
  workEmails: true,
  coachingTitleFilter: true,
  driveRootFolderId: true,
  fathomWebhookSecret: true,
} as const;

/**
 * Coaches eligible to receive recordings: anyone not deactivated who has a
 * webhook secret stored.
 *
 * Deliberately NOT gated on status ACTIVE. A coach is INVITED until their
 * first sign-in, and the onboarding script records a test meeting minutes
 * after Add Coach — gating ingest on login would make that test fail by
 * design, and drop real sessions for a coach who has not logged in yet.
 */
async function candidateCoaches() {
  return prisma.coach.findMany({
    where: { status: { not: "INACTIVE" }, fathomWebhookSecret: { not: null } },
    select: CANDIDATE_SELECT,
  });
}

function strip(row: Awaited<ReturnType<typeof candidateCoaches>>[number]): CoachIdentity {
  const { fathomWebhookSecret: _secret, ...identity } = row;
  return identity;
}

/** Decrypt a stored secret, treating a corrupt value as a non-match rather than a crash. */
function secretOf(row: { fathomWebhookSecret: string | null; name: string }): string | null {
  try {
    return decryptOptional(row.fathomWebhookSecret);
  } catch {
    console.error(
      `Could not decrypt the Fathom webhook secret for coach "${row.name}" — ` +
        `it was encrypted with a different COACHIQ_SECRETS_KEY, or the column was altered.`
    );
    return null;
  }
}

/**
 * Pre-multi-coach, the webhook verified against a single environment secret.
 * If the backfill onto the OWNER's row has not run, falling back to that env
 * value is the difference between a normal day and every recording being
 * rejected until someone reads the logs — Fathom stops retrying, so those
 * sessions are unrecoverable.
 *
 * Deliberately loud: it announces itself on every use so it cannot quietly
 * become the permanent mechanism.
 */
async function legacyEnvFallback(
  payload: Buffer,
  headers: SignatureHeaders
): Promise<CoachIdentity | null> {
  const envSecret = process.env.COACHIQ_FATHOM_WEBHOOK_SECRET?.trim();
  if (!envSecret || !verifySignature(payload, headers, envSecret)) return null;

  const owner = await prisma.coach.findFirst({
    where: { role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: CANDIDATE_SELECT,
  });
  if (!owner) return null;

  console.warn(
    `[fathom-webhook] Verified against the legacy COACHIQ_FATHOM_WEBHOOK_SECRET, ` +
      `not a stored per-coach secret. Run scripts/backfill-fathom-secret.ts to move it ` +
      `onto ${owner.name}'s coach row; this fallback will be removed.`
  );
  return strip(owner);
}

export async function resolveWebhookCoach(
  payload: Buffer,
  headers: SignatureHeaders,
  senderEmail: string | null
): Promise<ResolveOutcome> {
  const coaches = await candidateCoaches();
  if (coaches.length === 0) {
    const legacy = await legacyEnvFallback(payload, headers);
    if (legacy) return { ok: true, coach: legacy, matchedBy: "fallback" };
    return { ok: false, reason: "no_coaches_configured", senderEmail };
  }

  // 1. Routing hint: whose work address recorded this?
  const sender = senderEmail
    ? coaches.find(
        (c) =>
          c.loginEmail.toLowerCase() === senderEmail ||
          c.workEmails.some((e) => e.toLowerCase() === senderEmail)
      )
    : undefined;

  if (sender) {
    const secret = secretOf(sender);
    if (secret && verifySignature(payload, headers, secret)) {
      return { ok: true, coach: strip(sender), matchedBy: "sender" };
    }
    // No usable secret is a different failure from a secret that did not
    // verify. It means the stored value could not be decrypted — a
    // COACHIQ_SECRETS_KEY that differs from the one the backfill ran under.
    // Returning the named failure here would drop every one of this coach's
    // recordings permanently, which is exactly what the env fallback exists
    // to prevent, on the path their recordings actually take.
    if (!secret) {
      const legacy = await legacyEnvFallback(payload, headers);
      if (legacy) return { ok: true, coach: legacy, matchedBy: "fallback" };
    }
    // The secret decrypted and simply did not match: wrong, rotated, or
    // re-registered without updating the stored value. Name it.
    return {
      ok: false,
      reason: "sender_secret_mismatch",
      senderEmail,
      coachName: sender.name,
    };
  }

  // 2. No coach claims the sender address (a coach recording from an address
  //    nobody registered). Fall back to trying each secret.
  for (const coach of coaches) {
    const secret = secretOf(coach);
    if (secret && verifySignature(payload, headers, secret)) {
      return { ok: true, coach: strip(coach), matchedBy: "fallback" };
    }
  }

  // Coaches exist with secrets, but none verified. The env secret may still
  // be the live one if the backfill has not run yet.
  const legacy = await legacyEnvFallback(payload, headers);
  if (legacy) return { ok: true, coach: legacy, matchedBy: "fallback" };

  return { ok: false, reason: "no_secret_matched", senderEmail };
}

/** Operator-facing sentence for a rejected payload. Never returned to the caller. */
export function describeFailure(outcome: Extract<ResolveOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case "no_coaches_configured":
      return "A Fathom webhook arrived but no coach has a webhook secret stored — recordings are being dropped.";
    case "sender_secret_mismatch":
      return (
        `A Fathom webhook from ${outcome.senderEmail} matched coach "${outcome.coachName}", ` +
        `but the signature did not verify against their stored secret. The secret is likely stale — ` +
        `re-register the webhook for this coach. Recordings from them are being dropped.`
      );
    case "no_secret_matched":
      return (
        `A Fathom webhook${outcome.senderEmail ? ` from ${outcome.senderEmail}` : ""} did not verify ` +
        `against any coach's secret. If this address belongs to a coach, add it to their work emails.`
      );
  }
}
