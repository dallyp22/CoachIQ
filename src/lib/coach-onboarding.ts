import { clerkClient } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { encryptOptional, decryptOptional } from "@/lib/secrets";
import { registerWebhook } from "@/lib/fathom";
import { appBaseUrl, fathomWebhookUrl } from "@/lib/app-url";

/**
 * Provision a coach across three systems: our database, Clerk, and Fathom.
 *
 *   Coach row (already created by the caller)
 *        ├── Clerk invitation, carrying coachId in public metadata
 *        └── Fathom webhook registration, returning the signing secret
 *
 * The two external steps are best-effort and independently retryable. A
 * failure in either leaves a coach who exists and is visible with a FAILED
 * chip and a Retry button, rather than a half-created account that looks fine
 * but silently never receives recordings.
 *
 * Rolling the row back on an external failure would be a lie: a Clerk
 * invitation cannot be un-sent, and Fathom may have registered the webhook
 * before the response was lost.
 *
 * Every step is idempotent, so a double-submitted form or a Retry cannot
 * produce two invitations or — importantly — two webhooks, which would
 * ingest and bill every meeting twice.
 */

export type ProvisionResult = {
  inviteStatus: "OK" | "FAILED";
  fathomStatus: "OK" | "FAILED" | "PENDING";
  inviteError?: string;
  fathomError?: string;
};

export async function provisionCoach(coachId: string): Promise<ProvisionResult> {
  const coach = await prisma.coach.findUnique({
    where: { id: coachId },
    select: {
      id: true,
      loginEmail: true,
      clerkUserId: true,
      inviteStatus: true,
      fathomApiKey: true,
      fathomWebhookId: true,
      fathomStatus: true,
    },
  });
  if (!coach) throw new Error(`Coach ${coachId} not found.`);

  const result: ProvisionResult = { inviteStatus: "FAILED", fathomStatus: "PENDING" };

  // ── Clerk invitation ──
  if (coach.clerkUserId || coach.inviteStatus === "OK") {
    // Already linked or already invited — re-sending would be noise.
    result.inviteStatus = "OK";
  } else {
    try {
      const clerk = await clerkClient();
      await clerk.invitations.createInvitation({
        emailAddress: coach.loginEmail,
        // Rides the invite link, so first sign-in binds to the right coach even
        // if they sign up with a different address than we invited.
        publicMetadata: { coachId: coach.id },
        redirectUrl: `${appBaseUrl()}/sign-in`,
        // Makes a double-submit a no-op instead of an error.
        ignoreExisting: true,
      });
      result.inviteStatus = "OK";
    } catch (err) {
      result.inviteError = err instanceof Error ? err.message : "Unknown error";
      console.error(`[add-coach] Clerk invitation failed for ${coach.loginEmail}:`, result.inviteError);
    }
  }

  // ── Fathom webhook ──
  if (coach.fathomWebhookId) {
    // Already registered. Fathom has no list endpoint, so this stored id is
    // the only thing standing between a retry and a duplicate webhook.
    result.fathomStatus = "OK";
  } else {
    let apiKey: string | null = null;
    try {
      apiKey = decryptOptional(coach.fathomApiKey);
    } catch (err) {
      result.fathomError = "Stored Fathom API key could not be decrypted.";
      console.error(`[add-coach] ${result.fathomError}`, err);
    }

    if (!apiKey && !result.fathomError) {
      // No key supplied — the coach is set up for manual webhook entry.
      result.fathomStatus = "PENDING";
    } else if (apiKey) {
      try {
        const webhook = await registerWebhook(apiKey, fathomWebhookUrl());
        await prisma.coach.update({
          where: { id: coach.id },
          data: {
            fathomWebhookId: webhook.id,
            fathomWebhookSecret: encryptOptional(webhook.secret),
          },
        });
        result.fathomStatus = "OK";
      } catch (err) {
        result.fathomStatus = "FAILED";
        result.fathomError = err instanceof Error ? err.message : "Unknown error";
        console.error(`[add-coach] Fathom webhook registration failed:`, result.fathomError);
      }
    } else {
      result.fathomStatus = "FAILED";
    }
  }

  await prisma.coach.update({
    where: { id: coach.id },
    data: { inviteStatus: result.inviteStatus, fathomStatus: result.fathomStatus },
  });

  return result;
}

/**
 * What still needs a human after provisioning — the success screen's
 * "you're not done yet" list. Mirrors the onboarding checklist so nothing
 * that used to be a manual step quietly disappears.
 */
export function outstandingActions(
  result: ProvisionResult,
  coach: { googleCalendarId: string | null; driveRootFolderId: string | null }
): string[] {
  const todo: string[] = [];
  if (result.inviteStatus === "FAILED") {
    todo.push("Clerk invitation could not be sent — retry it from the Coaches list.");
  }
  if (result.fathomStatus === "PENDING") {
    todo.push(
      `No Fathom API key was provided. Add the webhook manually in Fathom (destination ${fathomWebhookUrl()}) and paste the signing secret here.`
    );
  }
  if (result.fathomStatus === "FAILED") {
    todo.push("Fathom webhook registration failed — retry it, or paste a signing secret manually.");
  }
  if (!coach.googleCalendarId) {
    todo.push("No calendar configured — the coach shares their coaching calendar, then add its ID.");
  }
  if (!coach.driveRootFolderId) {
    todo.push("No Drive folder configured — transcripts will fall back to the practice-wide root.");
  }
  return todo;
}
