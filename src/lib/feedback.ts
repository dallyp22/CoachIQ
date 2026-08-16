import type { FeedbackStage, FeedbackType, FeedbackPriority } from "@/generated/prisma/enums";

/**
 * Feedback stage vocabulary, shared by the API (validation), the page (query),
 * and the client components (labels + the visual rail). Kept framework-free so
 * both a server route and a "use client" component can import it.
 */

/**
 * The LINEAR pipeline, in order. DECLINED is deliberately absent — it is a dead
 * end, not a further step, so the rail derives progress from a position in this
 * array and treats DECLINED separately. Order here is the single source of
 * truth for "how far along" everywhere.
 */
export const STAGE_ORDER: readonly FeedbackStage[] = [
  "SUBMITTED",
  "ACKNOWLEDGED",
  "INVESTIGATING",
  "PLANNED",
  "IN_PROGRESS",
  "SHIPPED",
] as const;

/** Every stage a triager can set, including the off-rail terminal DECLINED. */
export const ALL_STAGES: readonly FeedbackStage[] = [...STAGE_ORDER, "DECLINED"] as const;

export const STAGE_LABELS: Record<FeedbackStage, string> = {
  SUBMITTED: "Submitted",
  ACKNOWLEDGED: "Acknowledged",
  INVESTIGATING: "Investigating",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  SHIPPED: "Shipped",
  DECLINED: "Declined",
};

export const TYPE_LABELS: Record<FeedbackType, string> = {
  BUG: "Bug",
  FEATURE: "Feature",
};

export const PRIORITY_LABELS: Record<FeedbackPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

/** A stage that closes the item — no further movement is expected. */
export function isTerminalStage(stage: FeedbackStage): boolean {
  return stage === "SHIPPED" || stage === "DECLINED";
}

export function isDeclined(stage: FeedbackStage): boolean {
  return stage === "DECLINED";
}

/**
 * Position on the rail. Returns -1 for DECLINED (off-rail) so callers must
 * handle it explicitly rather than accidentally rendering it as "before
 * Submitted".
 */
export function stageIndex(stage: FeedbackStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function isValidStage(value: unknown): value is FeedbackStage {
  return typeof value === "string" && (ALL_STAGES as readonly string[]).includes(value);
}

export function isValidType(value: unknown): value is FeedbackType {
  return value === "BUG" || value === "FEATURE";
}

export function isValidPriority(value: unknown): value is FeedbackPriority {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "URGENT";
}
