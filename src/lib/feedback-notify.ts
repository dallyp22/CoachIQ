import { prisma } from "@/lib/db";
import type { CoachRole } from "@/generated/prisma/enums";

/**
 * How many feedback items have activity this coach hasn't seen — the nav badge.
 *
 * "Unseen" = a stage move or a comment newer than feedbackLastSeenAt that the
 * coach did not cause themselves:
 *   - Reporter (COACH): their own items that were acknowledged, moved, or
 *     replied to. Team replies (null author) count — that's the owner speaking.
 *   - Owner/admin (scope = all items): new submissions and coach replies to
 *     triage. Team (null-author) comments are excluded here, because the admin
 *     writes those and shouldn't notify themselves.
 *
 * Prisma's `not` includes NULLs, so `changedById: { not: me }` also catches
 * system/other moves — intended for the reporter, harmless for the admin.
 */
export async function feedbackUnreadCount(coach: {
  id: string;
  role: CoachRole;
  feedbackLastSeenAt: Date | null;
}): Promise<number> {
  const since = coach.feedbackLastSeenAt ?? new Date(0);
  const isAdmin = coach.role !== "COACH";

  const commentByOther = isAdmin
    ? { createdAt: { gt: since }, AND: [{ authorId: { not: null } }, { authorId: { not: coach.id } }] }
    : { createdAt: { gt: since }, authorId: { not: coach.id } };

  return prisma.feedbackItem.count({
    where: {
      ...(isAdmin ? {} : { submittedById: coach.id }),
      OR: [
        { changes: { some: { changedAt: { gt: since }, changedById: { not: coach.id } } } },
        { comments: { some: commentByOther } },
      ],
    },
  });
}
