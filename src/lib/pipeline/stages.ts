import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Stage rules that more than one route needs.
 *
 * The partial unique index in the migration already makes two live WON stages
 * impossible. What SQL cannot express is the other half — refusing to archive
 * the LAST one — because "last" is a count, not a row constraint. That guard
 * lives here so the stage-settings route and any future caller share it
 * instead of each re-deriving the rule.
 */

export type StageRow = {
  id: string;
  name: string;
  sortOrder: number;
  isHot: boolean;
  terminal: "WON" | "LOST" | null;
  isArchived: boolean;
};

const STAGE_SELECT = {
  id: true,
  name: true,
  sortOrder: true,
  isHot: true,
  terminal: true,
  isArchived: true,
} as const;

/** Live stages in display order. Archived ones still hold historical rows. */
export async function liveStages(): Promise<StageRow[]> {
  return prisma.pipelineStage.findMany({
    where: { isArchived: false },
    orderBy: { sortOrder: "asc" },
    select: STAGE_SELECT,
  });
}

/** The single live stage carrying an outcome, or null if somehow none exists. */
export async function terminalStage(
  outcome: "WON" | "LOST",
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<StageRow | null> {
  return tx.pipelineStage.findFirst({
    where: { terminal: outcome, isArchived: false },
    select: STAGE_SELECT,
  });
}

/** The stage a new prospect lands in when none is named. */
export async function defaultStage(
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<StageRow | null> {
  return tx.pipelineStage.findFirst({
    where: { isArchived: false, terminal: null },
    orderBy: { sortOrder: "asc" },
    select: STAGE_SELECT,
  });
}

export type ArchiveRefusal = { ok: false; reason: string };
export type ArchiveOk = { ok: true };

/**
 * May this stage be archived?
 *
 * Two refusals, both about leaving the board in a state the rest of the module
 * assumes cannot happen:
 *
 *   - It still holds prospects. Archiving would hide them from every view
 *     without deleting them — they'd exist, uncounted, in no visible stage.
 *   - It is the last live WON or LOST stage. Convert-to-client fires when a
 *     prospect reaches the WON stage; with none, closing a deal silently
 *     stops creating clients and nobody notices until someone asks where a
 *     client went.
 */
export async function canArchiveStage(stageId: string): Promise<ArchiveOk | ArchiveRefusal> {
  const stage = await prisma.pipelineStage.findUnique({
    where: { id: stageId },
    select: { ...STAGE_SELECT, _count: { select: { prospects: true } } },
  });

  if (!stage) return { ok: false, reason: "Stage not found" };
  if (stage.isArchived) return { ok: true }; // already there; idempotent

  if (stage._count.prospects > 0) {
    return {
      ok: false,
      reason:
        `"${stage.name}" still holds ${stage._count.prospects} prospect(s). ` +
        `Move them to another stage first — archiving would hide them from every view.`,
    };
  }

  if (stage.terminal) {
    const liveSiblings = await prisma.pipelineStage.count({
      where: { terminal: stage.terminal, isArchived: false, id: { not: stageId } },
    });
    if (liveSiblings === 0) {
      return {
        ok: false,
        reason:
          `"${stage.name}" is the only ${stage.terminal} stage. ` +
          (stage.terminal === "WON"
            ? "Without it, closing a deal would stop creating clients."
            : "Without it, there would be no way to close a prospect as lost."),
      };
    }
  }

  return { ok: true };
}

/** Non-empty trimmed string, or null. */
export function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
