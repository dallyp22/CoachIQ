import { redirect } from "next/navigation";
import { requireCoach, AuthzError, type ResolvedCoach } from "@/lib/authz";
import type { CoachRole } from "@/generated/prisma/enums";

/**
 * Server-component flavour of requireCoach.
 *
 * Pages cannot return a 403 body, so an unauthenticated visitor goes to
 * sign-in and a signed-in stranger goes to /no-access. Every server component
 * under app/(dashboard) that reads coach-owned data must call this and pass
 * the resolved scope into its queries.
 */
export async function requireCoachPage(minRole: CoachRole = "COACH"): Promise<ResolvedCoach> {
  try {
    return await requireCoach(minRole);
  } catch (err) {
    if (err instanceof AuthzError) {
      redirect(err.code === "unauthenticated" ? "/sign-in" : "/no-access");
    }
    // Anything else — a database outage, a Clerk timeout — is an
    // infrastructure failure, not an authorization decision. Re-throw so the
    // error boundary handles it. Swallowing it here would tell every user at
    // once that they are not a coach, and this call sits in the dashboard
    // layout, so that message would cover the entire app.
    throw err;
  }
}
