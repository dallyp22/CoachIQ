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
    if (err instanceof AuthzError && err.code === "unauthenticated") {
      redirect("/sign-in");
    }
    redirect("/no-access");
  }
}
