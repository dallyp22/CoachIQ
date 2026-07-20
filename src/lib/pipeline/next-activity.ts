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
  // Stage-aware on purpose. A closed prospect can still carry a dangling future
  // plan, so a stage-blind recompute would re-arm it: deleting an unrelated
  // activity, or just editing a note, would put a date back on a won deal and
  // resume the overdue-amber nagging that closing it was supposed to stop.
  const prospect = await tx.prospect.findUnique({
    where: { id: prospectId },
    select: { stage: { select: { terminal: true } } },
  });

  const next = prospect?.stage.terminal
    ? null
    : await tx.pipelineActivity.findFirst({
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

// ─── Activity detail for a page of prospects ──────────

export type ActivityDetail = {
  activityAt: Date;
  notes: string | null;
  owner: { id: string; name: string } | null;
};

/**
 * The predicate defining "last activity": something that actually happened.
 *
 * Shared because it was hand-copied into four files, and if the rule ever
 * changes the list view and the reports would silently disagree about
 * staleness — which is the module's headline metric.
 */
export const LAST_ACTIVITY_WHERE = {
  OR: [{ kind: "LOGGED" as const }, { completedAt: { not: null } }],
};

/**
 * Last-completed and next-planned activity for a page of prospects, with the
 * notes and owner each one carries.
 *
 * §7.1 asks for Joel's fields 7-9 (last activity date, notes, owner) and 11-12
 * (next activity notes, owner), so a bare date is not enough. Four queries for
 * the whole page regardless of size — never one per row.
 */
export async function activityDetailFor(
  tx: Prisma.TransactionClient,
  prospectIds: string[]
): Promise<{ last: Map<string, ActivityDetail>; next: Map<string, ActivityDetail> }> {
  const last = new Map<string, ActivityDetail>();
  const next = new Map<string, ActivityDetail>();
  if (prospectIds.length === 0) return { last, next };

  const select = {
    prospectId: true,
    activityAt: true,
    notes: true,
    owner: { select: { id: true, name: true } },
  } as const;

  const [lastMax, nextMin] = await Promise.all([
    tx.pipelineActivity.groupBy({
      by: ["prospectId"],
      where: { prospectId: { in: prospectIds }, ...LAST_ACTIVITY_WHERE },
      _max: { activityAt: true },
    }),
    tx.pipelineActivity.groupBy({
      by: ["prospectId"],
      where: { prospectId: { in: prospectIds }, kind: "PLANNED", completedAt: null },
      _min: { activityAt: true },
    }),
  ]);

  const [lastRows, nextRows] = await Promise.all([
    lastMax.length === 0
      ? []
      : tx.pipelineActivity.findMany({
          where: {
            // Re-apply the predicate. Without it a PLANNED row sharing the exact
            // timestamp of the true last activity can win the first-wins dedup
            // below and render a FUTURE plan as "last activity".
            ...LAST_ACTIVITY_WHERE,
            OR: lastMax
              .filter((l) => l._max.activityAt !== null)
              .map((l) => ({ prospectId: l.prospectId, activityAt: l._max.activityAt! })),
          },
          select,
        }),
    nextMin.length === 0
      ? []
      : tx.pipelineActivity.findMany({
          where: {
            kind: "PLANNED",
            completedAt: null,
            OR: nextMin
              .filter((n) => n._min.activityAt !== null)
              .map((n) => ({ prospectId: n.prospectId, activityAt: n._min.activityAt! })),
          },
          select,
        }),
  ]);

  for (const r of lastRows) {
    if (!last.has(r.prospectId)) {
      last.set(r.prospectId, { activityAt: r.activityAt, notes: r.notes, owner: r.owner });
    }
  }
  for (const r of nextRows) {
    if (!next.has(r.prospectId)) {
      next.set(r.prospectId, { activityAt: r.activityAt, notes: r.notes, owner: r.owner });
    }
  }
  return { last, next };
}
