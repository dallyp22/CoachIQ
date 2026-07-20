import type { Prisma } from "@/generated/prisma/client";

/**
 * Maintains the denormalized `Prospect.nextActivityAt`.
 *
 * WHY THE COLUMN EXISTS: the pipeline list defaults to "stalest first" (PRD
 * §6.2). Computing next-activity after fetching a page can only sort that
 * page against itself, so the genuinely most-neglected prospect can sit on
 * page 3 forever — breaking the one view that justifies the module. A real
 * column makes the sort and its pagination correct in SQL.
 *
 * WHY IT IS A SINGLE FUNCTION: a denormalized column is only as good as its
 * least disciplined writer, and drift here is SILENT — no error, just a wrong
 * sort order nobody can falsify from the UI. Every path that can change which
 * activity is "next" calls this and recomputes from the source of truth,
 * rather than each one patching the column with what it thinks changed:
 *
 *   create a PLANNED activity      → a sooner one may now exist
 *   complete a PLANNED activity    → it is no longer next
 *   delete an activity             → the next-next one moves up
 *   PATCH activityAt (reschedule)  → ordering changes with no create/delete
 *   move to a terminal stage       → clearTerminal(), below
 *
 * The PATCH case is the one that hides: rescheduling Thursday's call to next
 * Tuesday is neither a create nor a delete, and omitting it leaves a row
 * displaying the new date while sorting by the old one.
 */

/**
 * Recompute from the activity rows and write it back.
 *
 * Always call inside the same transaction as the activity mutation. Outside
 * one, a failure after the activity write leaves the column stale — which is
 * precisely the invisible drift this function exists to prevent.
 */
export async function refreshNextActivityAt(
  tx: Prisma.TransactionClient,
  prospectId: string
): Promise<Date | null> {
  const next = await tx.pipelineActivity.findFirst({
    where: { prospectId, kind: "PLANNED", completedAt: null },
    orderBy: { activityAt: "asc" },
    select: { activityAt: true },
  });

  const value = next?.activityAt ?? null;
  await tx.prospect.update({
    where: { id: prospectId },
    data: { nextActivityAt: value },
  });
  return value;
}

/**
 * Clear the column when a prospect closes (WON or LOST).
 *
 * A closed-won prospect can still carry a dangling future planned activity.
 * Left set, it keeps the prospect eligible for the overdue-amber state of
 * §6.2 — nagging about a lead that is already finished.
 */
export async function clearNextActivityAt(
  tx: Prisma.TransactionClient,
  prospectId: string
): Promise<void> {
  await tx.prospect.update({
    where: { id: prospectId },
    data: { nextActivityAt: null },
  });
}

/**
 * Ordering for the default list view.
 *
 * NULLS FIRST is not a preference. Postgres defaults ASC to NULLS LAST, which
 * would place every prospect WITH a plan above every prospect without one —
 * sinking "none scheduled" (§6.2's muted-red state, and a tracked success
 * metric in §3) to the bottom of the list and off the first page.
 *
 * A null here is not a missing date. It is the worst condition on the board.
 */
export const STALEST_FIRST = {
  nextActivityAt: { sort: "asc", nulls: "first" },
} as const satisfies Prisma.ProspectOrderByWithRelationInput;
