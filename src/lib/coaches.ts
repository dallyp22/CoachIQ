import { prisma } from "@/lib/db";
import type { ResolvedCoach } from "@/lib/authz";

/**
 * The coach list that feeds the admin CoachFilter ("All coaches / Todd / Kurt").
 *
 * A COACH is pinned to themselves by scopeCoachId, so the control would be a
 * single option that changes nothing — we return just their own row and callers
 * hide the filter. OWNER/ADMIN get every coach that isn't deactivated, in the
 * same name order the filter renders them.
 *
 * INACTIVE coaches are excluded because filtering to one would show a book that
 * no longer receives sessions; their historical rows still appear under
 * "All coaches", they just aren't a selectable lens.
 */
export async function coachesForFilter(
  coach: Pick<ResolvedCoach, "id" | "name" | "role">
): Promise<Array<{ id: string; name: string }>> {
  if (coach.role === "COACH") return [{ id: coach.id, name: coach.name }];
  return prisma.coach.findMany({
    where: { status: { not: "INACTIVE" } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
