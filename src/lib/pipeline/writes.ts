import { prisma } from "@/lib/db";
import { canAccessProspect } from "@/lib/authz";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { clearNextActivityAt, refreshNextActivityAt } from "@/lib/pipeline/next-activity";
import { defaultStage, cleanString } from "@/lib/pipeline/stages";

/**
 * Shared pipeline WRITE services — the single owners of the create-prospect,
 * move-stage, and log-activity operations, so the HTTP routes and the MCP tools
 * run the identical transaction and side-effects rather than two hand-kept
 * copies. Extracted after a review caught the copy in the MCP tools drifting:
 * it wrote the PROSPECT_STAGE_CHANGED audit with stage UUIDs while the route
 * wrote stage names — one event, two shapes in the persisted audit trail. With
 * one owner, the four load-bearing side-effects (stageChange history,
 * clear/refresh nextActivityAt, the audit row) are defined once.
 *
 * Each function returns a discriminated result rather than an HTTP response, so
 * the route maps it to NextResponse and the MCP tool maps it to a tool result.
 */

export const OPPORTUNITY_TYPES = ["COACHING", "FACILITATION", "IMPLEMENTATION", "MULTIPLE"];

const MS_PER_DAY = 86_400_000;

/** Days since a timestamp (float, never negative). Shared so list views agree. */
export function daysSince(from: Date): number {
  return Math.max(0, (Date.now() - from.getTime()) / MS_PER_DAY);
}

/**
 * The status → stage.terminal WHERE fragment for a prospect list. `open` is the
 * default everywhere (a pipeline is about what is still live). Shared by the
 * list route and the MCP list_prospects tool so the two never disagree.
 */
export function terminalFilterForStatus(status: string) {
  return status === "open"
    ? { stage: { terminal: null } }
    : status === "won"
      ? { stage: { terminal: "WON" as const } }
      : status === "lost"
        ? { stage: { terminal: "LOST" as const } }
        : {};
}

// ─── Move a prospect's stage ──────────────────────────────

type StageShape = { id: string; name: string; terminal: "WON" | "LOST" | null; isArchived: boolean };

export type MoveProspectStageInput = {
  prospectId: string;
  toStageId: string;
  lostReason?: string | null;
  /** Coach scope for authorization (null = whole practice). */
  scopeCoachId: string | null;
  /** Coach id written to prospectStageChange.changedById. */
  changedByCoachId: string;
  /** Clerk userId written as the audit actor (null = system). */
  auditActor: string | null;
};

export type MoveProspectStageResult =
  | {
      ok: false;
      code: "prospect_not_found" | "stage_not_found" | "stage_archived" | "lost_reason_required";
      message: string;
    }
  | { ok: true; status: "unchanged"; stage: StageShape }
  | { ok: true; status: "moved"; stage: StageShape; convertAvailable: boolean };

/**
 * The ONE place a prospect's stageId changes. Writes ProspectStageChange, resets
 * stageEnteredAt, enforces the LOST-needs-a-reason rule, and clears/refreshes
 * nextActivityAt on close/reopen. See the stage route docstring for why a
 * generic PATCH is refused — all four side-effects must move together.
 */
export async function moveProspectStage(
  input: MoveProspectStageInput
): Promise<MoveProspectStageResult> {
  const { prospectId, toStageId, scopeCoachId, changedByCoachId, auditActor } = input;
  const lostReason = cleanString(input.lostReason ?? null);

  const [prospect, toStage] = await Promise.all([
    prisma.prospect.findUnique({
      where: { id: prospectId },
      select: {
        id: true,
        coachId: true,
        assignedCoachId: true,
        stageId: true,
        convertedToClientId: true,
        stage: { select: { id: true, name: true, terminal: true } },
      },
    }),
    prisma.pipelineStage.findUnique({
      where: { id: toStageId },
      select: { id: true, name: true, terminal: true, isArchived: true },
    }),
  ]);

  if (!prospect || !canAccessProspect(scopeCoachId, prospect)) {
    return { ok: false, code: "prospect_not_found", message: "Prospect not found" };
  }
  if (!toStage) {
    return { ok: false, code: "stage_not_found", message: "Stage not found" };
  }
  if (toStage.isArchived) {
    return {
      ok: false,
      code: "stage_archived",
      message: `"${toStage.name}" is archived — prospects cannot be moved into it`,
    };
  }
  if (prospect.stageId === toStage.id) {
    // Idempotent: a double-click must not write a self-transition into the
    // history the funnel reports read.
    return { ok: true, status: "unchanged", stage: toStage };
  }
  if (toStage.terminal === "LOST" && !lostReason) {
    return {
      ok: false,
      code: "lost_reason_required",
      message: "Moving a prospect to a lost stage requires a reason",
    };
  }

  const fromStageId = prospect.stageId;

  await prisma.$transaction(async (tx) => {
    await tx.prospect.update({
      where: { id: prospectId },
      data: {
        stageId: toStage.id,
        stageEnteredAt: new Date(),
        // Clear a stale reason when reopening a lost prospect.
        lostReason: toStage.terminal === "LOST" ? lostReason : null,
      },
    });
    // Typed history — DATA the reports query, not just a log line.
    await tx.prospectStageChange.create({
      data: { prospectId, fromStageId, toStageId: toStage.id, changedById: changedByCoachId },
    });
    // Closing clears next-activity; the else is load-bearing — reopening must
    // recompute or the column lies about "none scheduled".
    if (toStage.terminal) {
      await clearNextActivityAt(tx, prospectId);
    } else {
      await refreshNextActivityAt(tx, prospectId);
    }
    await logEvent(tx, {
      event: BillingEvent.PROSPECT_STAGE_CHANGED,
      actor: auditActor,
      // Canonical payload shape (stage NAMES). Both callers go through here, so
      // there is exactly one shape for this event in the audit trail.
      payload: {
        prospectId,
        from: prospect.stage.name,
        to: toStage.name,
        terminal: toStage.terminal,
        ...(lostReason ? { lostReason } : {}),
      },
    });
  });

  return {
    ok: true,
    status: "moved",
    stage: toStage,
    convertAvailable: toStage.terminal === "WON" && !prospect.convertedToClientId,
  };
}

// ─── Log a pipeline activity ──────────────────────────────

export type CreatePipelineActivityInput = {
  prospectId: string;
  kind: "LOGGED" | "PLANNED";
  activityAt: Date;
  notes?: string | null;
  /** Already-resolved owner (coach id, or null = "System"). */
  ownerId: string | null;
  scopeCoachId: string | null;
};

export type CreatePipelineActivityResult =
  | { ok: false; code: "prospect_not_found"; message: string }
  | {
      ok: true;
      activity: {
        id: string;
        kind: "LOGGED" | "PLANNED";
        activityAt: Date;
        notes: string | null;
        completedAt: Date | null;
      };
    };

/**
 * Create one activity and keep nextActivityAt correct in the same transaction.
 * A LOGGED activity is complete-on-arrival; a PLANNED one becomes the prospect's
 * next activity. refreshNextActivityAt MUST run in-tx or the stalest-first sort
 * silently drifts.
 */
export async function createPipelineActivity(
  input: CreatePipelineActivityInput
): Promise<CreatePipelineActivityResult> {
  const { prospectId, kind, activityAt, ownerId, scopeCoachId } = input;

  const prospect = await prisma.prospect.findUnique({
    where: { id: prospectId },
    select: { id: true, coachId: true, assignedCoachId: true },
  });
  if (!prospect || !canAccessProspect(scopeCoachId, prospect)) {
    return { ok: false, code: "prospect_not_found", message: "Prospect not found" };
  }

  const activity = await prisma.$transaction(async (tx) => {
    const created = await tx.pipelineActivity.create({
      data: {
        prospectId,
        kind: kind as never,
        activityAt,
        notes: cleanString(input.notes ?? null),
        ownerId,
        // LOGGED already happened, so it is complete on arrival.
        completedAt: kind === "LOGGED" ? activityAt : null,
      },
      select: { id: true, kind: true, activityAt: true, notes: true, completedAt: true },
    });
    await refreshNextActivityAt(tx, prospectId);
    return created;
  });

  return { ok: true, activity };
}

// ─── Create prospects (batch) ─────────────────────────────

export type ProspectInput = {
  firstName?: unknown;
  lastName?: unknown;
  company?: unknown;
  needSummary?: unknown;
  email?: unknown;
  phone?: unknown;
  opportunityType?: unknown;
  notes?: unknown;
  stageId?: unknown;
  assignedCoachId?: unknown;
};

export type CreateProspectsResult =
  | { ok: false; code: "no_open_stage"; message: string }
  | {
      ok: true;
      created: Array<{ id: string; firstName: string; lastName: string }>;
      failed: Array<{ name: string; error: string }>;
    };

/**
 * Create one prospect or a batch. Owns the "open stage only" and "valid
 * assignee only" guards, the per-row create + stage-history transaction, and the
 * single PROSPECT_CREATED audit — so the HTTP route and the MCP create_prospect
 * tool share one definition (mirrors createClients). The CALLER resolves whose
 * book (`coachId`); a COACH may only ever pass their own id.
 */
export async function createProspects(
  coachId: string,
  rows: ProspectInput[],
  actor: { coachId: string; userId: string | null }
): Promise<CreateProspectsResult> {
  const fallbackStage = await defaultStage();
  if (!fallbackStage) {
    return {
      ok: false,
      code: "no_open_stage",
      message: "No open pipeline stage exists to place a prospect in",
    };
  }

  // A prospect may only be CREATED into a live, open stage — never straight into
  // WON (which would let convert mint a client with no history) or an archived
  // stage (a row visible in no stage at all).
  const openStages = await prisma.pipelineStage.findMany({
    where: { isArchived: false, terminal: null },
    select: { id: true },
  });
  const openStageIds = new Set(openStages.map((s) => s.id));

  // Validate assignees: prospectWhere() matches on assignedCoachId, so an
  // unvalidated value would inject a row onto another coach's board.
  const requestedAssignees = new Set(
    rows.map((r) => cleanString(r.assignedCoachId)).filter((v): v is string => v !== null)
  );
  const validAssignees = new Set(
    requestedAssignees.size === 0
      ? []
      : (
          await prisma.coach.findMany({
            where: { id: { in: [...requestedAssignees] }, status: { not: "INACTIVE" } },
            select: { id: true },
          })
        ).map((c) => c.id)
  );

  const created: Array<{ id: string; firstName: string; lastName: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const row of rows) {
    const firstName = cleanString(row.firstName) ?? "";
    const lastName = cleanString(row.lastName) ?? "";
    if (!firstName && !lastName) {
      failed.push({ name: "(missing)", error: "A name is required" });
      continue;
    }
    // Email optional here (required on Client at convert). Never coerce blank to
    // "": clients are unique on (coachId, email).
    const email = cleanString(row.email)?.toLowerCase() ?? null;

    const requestedStage = cleanString(row.stageId);
    if (requestedStage && !openStageIds.has(requestedStage)) {
      failed.push({
        name: `${firstName} ${lastName}`.trim(),
        error: "That stage is closed or archived — a prospect can only be created in an open stage",
      });
      continue;
    }
    const stageId = requestedStage ?? fallbackStage.id;

    const requestedAssignee = cleanString(row.assignedCoachId);
    if (requestedAssignee && !validAssignees.has(requestedAssignee)) {
      failed.push({ name: `${firstName} ${lastName}`.trim(), error: "Assigned coach not found" });
      continue;
    }

    try {
      const prospect = await prisma.$transaction(async (tx) => {
        const p = await tx.prospect.create({
          data: {
            coachId,
            assignedCoachId: requestedAssignee,
            firstName,
            lastName,
            company: cleanString(row.company),
            needSummary: cleanString(row.needSummary),
            email,
            phone: cleanString(row.phone),
            opportunityType:
              typeof row.opportunityType === "string" &&
              OPPORTUNITY_TYPES.includes(row.opportunityType)
                ? (row.opportunityType as never)
                : "COACHING",
            notes: cleanString(row.notes),
            stageId,
            source: "MANUAL",
          },
          select: { id: true, firstName: true, lastName: true, stageId: true },
        });
        // Created-into-a-stage is a real transition (fromStageId null).
        await tx.prospectStageChange.create({
          data: { prospectId: p.id, fromStageId: null, toStageId: p.stageId, changedById: actor.coachId },
        });
        return p;
      });
      created.push({ id: prospect.id, firstName: prospect.firstName, lastName: prospect.lastName });
    } catch (err) {
      failed.push({
        name: `${firstName} ${lastName}`.trim(),
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  if (created.length > 0) {
    await logEvent(prisma, {
      event: BillingEvent.PROSPECT_CREATED,
      actor: actor.userId,
      payload: { count: created.length, coachId },
    });
  }

  return { ok: true, created, failed };
}
