import { prisma } from "@/lib/db";

/**
 * Resolve the practice OWNER's coach id.
 *
 * INTERIM — Phase 1 of the multi-coach foundation. Rows that are now
 * coach-owned (clients, billing groups) need a coach at creation time, but
 * `requireCoach()` (Phase 2) does not exist yet, so there is no signed-in
 * coach to attribute them to. Until it does, new rows fall to the OWNER,
 * which matches today's single-coach behaviour exactly.
 *
 * Phase 2 replaces every call site of this with the resolved signed-in coach.
 */
export async function getOwnerCoachId(): Promise<string> {
  const owner = await prisma.coach.findFirst({
    where: { role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!owner) {
    throw new Error(
      "No OWNER coach exists — the multi-coach migration should have seeded one."
    );
  }
  return owner.id;
}
