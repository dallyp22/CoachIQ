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

export async function resolveWebhookCoach(
  payload: Buffer,
  headers: SignatureHeaders,
  senderEmail: string | null
): Promise<ResolveOutcome> {
  const coaches = await candidateCoaches();
  if (coaches.length === 0) {
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
    // Named failure — the actionable case: this coach's secret is wrong,
    // rotated, or was re-registered without updating the stored value.
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
