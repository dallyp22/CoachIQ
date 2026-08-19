import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the shared pipeline write services. These are the single owners of
 * the move/activity/create transactions that BOTH the HTTP routes and the MCP
 * tools call — so the side-effects (stage history, next-activity clear/refresh,
 * the audit row and its canonical payload shape) are asserted here once.
 */

const m = vi.hoisted(() => ({
  prospectFindUnique: vi.fn(),
  prospectUpdate: vi.fn(),
  stageFindUnique: vi.fn(),
  stageFindFirst: vi.fn(),
  stageFindMany: vi.fn(),
  stageChangeCreate: vi.fn(),
  activityCreate: vi.fn(),
  prospectCreate: vi.fn(),
  coachFindMany: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
  logEvent: vi.fn(),
}));

// $transaction invokes the callback with a tx double carrying the write methods.
const tx = {
  prospect: { update: m.prospectUpdate, create: m.prospectCreate },
  prospectStageChange: { create: m.stageChangeCreate },
  pipelineActivity: { create: m.activityCreate },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    prospect: { findUnique: m.prospectFindUnique },
    pipelineStage: {
      findUnique: m.stageFindUnique,
      findFirst: m.stageFindFirst,
      findMany: m.stageFindMany,
    },
    coach: { findMany: m.coachFindMany },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

vi.mock("@/lib/pipeline/next-activity", () => ({
  clearNextActivityAt: m.clear,
  refreshNextActivityAt: m.refresh,
}));

vi.mock("@/lib/billing/audit", () => ({
  logEvent: m.logEvent,
  BillingEvent: { PROSPECT_STAGE_CHANGED: "PROSPECT_STAGE_CHANGED", PROSPECT_CREATED: "PROSPECT_CREATED" },
}));

import { moveProspectStage, createPipelineActivity, createProspects } from "@/lib/pipeline/writes";

const OPEN = { id: "s-open", name: "Negotiation", terminal: null, isArchived: false };
const WON = { id: "s-won", name: "Won", terminal: "WON", isArchived: false };
const LOST = { id: "s-lost", name: "Lost", terminal: "LOST", isArchived: false };

const KURT_PROSPECT = {
  id: "p1",
  coachId: "coach-kurt",
  assignedCoachId: null,
  stageId: "s-open",
  convertedToClientId: null,
  stage: { id: "s-open", name: "Negotiation", terminal: null },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moveProspectStage", () => {
  const base = { scopeCoachId: "coach-kurt", changedByCoachId: "coach-kurt", auditActor: "user_kurt" };

  it("a terminal (WON) move clears next-activity, never refreshes, and audits with stage NAMES + the Clerk userId", async () => {
    m.prospectFindUnique.mockResolvedValue(KURT_PROSPECT);
    m.stageFindUnique.mockResolvedValue(WON);

    const r = await moveProspectStage({ ...base, prospectId: "p1", toStageId: "s-won" });

    expect(r).toMatchObject({ ok: true, status: "moved", convertAvailable: true });
    expect(m.clear).toHaveBeenCalledTimes(1);
    expect(m.refresh).not.toHaveBeenCalled();
    expect(m.stageChangeCreate).toHaveBeenCalledWith({
      data: { prospectId: "p1", fromStageId: "s-open", toStageId: "s-won", changedById: "coach-kurt" },
    });
    // The whole reason this service exists: ONE audit shape, stage NAMES not UUIDs.
    expect(m.logEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        event: "PROSPECT_STAGE_CHANGED",
        actor: "user_kurt",
        payload: expect.objectContaining({ from: "Negotiation", to: "Won", terminal: "WON" }),
      })
    );
  });

  it("an open move refreshes next-activity instead of clearing", async () => {
    m.prospectFindUnique.mockResolvedValue(KURT_PROSPECT);
    m.stageFindUnique.mockResolvedValue({ ...OPEN, id: "s-mid", name: "Proposal" });

    await moveProspectStage({ ...base, prospectId: "p1", toStageId: "s-mid" });

    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(m.clear).not.toHaveBeenCalled();
  });

  it("refuses a LOST move with no reason, before any write", async () => {
    m.prospectFindUnique.mockResolvedValue(KURT_PROSPECT);
    m.stageFindUnique.mockResolvedValue(LOST);

    const r = await moveProspectStage({ ...base, prospectId: "p1", toStageId: "s-lost" });

    expect(r).toMatchObject({ ok: false, code: "lost_reason_required" });
    expect(m.stageChangeCreate).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("is idempotent on a same-stage move — no history row written", async () => {
    m.prospectFindUnique.mockResolvedValue(KURT_PROSPECT);
    m.stageFindUnique.mockResolvedValue(OPEN); // same as prospect.stageId

    const r = await moveProspectStage({ ...base, prospectId: "p1", toStageId: "s-open" });

    expect(r).toMatchObject({ ok: true, status: "unchanged" });
    expect(m.stageChangeCreate).not.toHaveBeenCalled();
  });

  it("returns prospect_not_found for another coach's prospect (404-not-403)", async () => {
    m.prospectFindUnique.mockResolvedValue({ ...KURT_PROSPECT, coachId: "coach-todd" });
    m.stageFindUnique.mockResolvedValue(WON);

    const r = await moveProspectStage({ ...base, prospectId: "p1", toStageId: "s-won" });

    expect(r).toMatchObject({ ok: false, code: "prospect_not_found" });
  });

  it("refuses moving into an archived stage", async () => {
    m.prospectFindUnique.mockResolvedValue(KURT_PROSPECT);
    m.stageFindUnique.mockResolvedValue({ ...WON, isArchived: true });

    const r = await moveProspectStage({ ...base, prospectId: "p1", toStageId: "s-won" });

    expect(r).toMatchObject({ ok: false, code: "stage_archived" });
  });
});

describe("createPipelineActivity", () => {
  it("marks a LOGGED activity complete-on-arrival and refreshes next-activity in-tx", async () => {
    m.prospectFindUnique.mockResolvedValue({ id: "p1", coachId: "coach-kurt", assignedCoachId: null });
    m.activityCreate.mockResolvedValue({ id: "a1", kind: "LOGGED", activityAt: new Date(), notes: null, completedAt: new Date() });
    const when = new Date("2026-08-19T10:00:00Z");

    const r = await createPipelineActivity({
      prospectId: "p1",
      kind: "LOGGED",
      activityAt: when,
      notes: null,
      ownerId: "coach-kurt",
      scopeCoachId: "coach-kurt",
    });

    expect(r.ok).toBe(true);
    expect(m.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "LOGGED", completedAt: when }) })
    );
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves a PLANNED activity open (completedAt null)", async () => {
    m.prospectFindUnique.mockResolvedValue({ id: "p1", coachId: "coach-kurt", assignedCoachId: null });
    m.activityCreate.mockResolvedValue({ id: "a2", kind: "PLANNED", activityAt: new Date(), notes: null, completedAt: null });

    await createPipelineActivity({
      prospectId: "p1",
      kind: "PLANNED",
      activityAt: new Date(),
      notes: null,
      ownerId: "coach-kurt",
      scopeCoachId: "coach-kurt",
    });

    expect(m.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt: null }) })
    );
  });

  it("refuses an activity on a prospect outside scope, with no write", async () => {
    m.prospectFindUnique.mockResolvedValue({ id: "p1", coachId: "coach-todd", assignedCoachId: null });

    const r = await createPipelineActivity({
      prospectId: "p1",
      kind: "LOGGED",
      activityAt: new Date(),
      notes: null,
      ownerId: "coach-kurt",
      scopeCoachId: "coach-kurt",
    });

    expect(r).toMatchObject({ ok: false, code: "prospect_not_found" });
    expect(m.activityCreate).not.toHaveBeenCalled();
  });
});

describe("createProspects", () => {
  const actor = { coachId: "coach-kurt", userId: "user_kurt" };

  beforeEach(() => {
    m.stageFindFirst.mockResolvedValue({ id: "s-open", name: "New", terminal: null, isArchived: false });
    m.stageFindMany.mockResolvedValue([{ id: "s-open" }]);
    m.coachFindMany.mockResolvedValue([]);
  });

  it("creates into the default open stage, writes the created-into transition, and audits once", async () => {
    m.prospectCreate.mockResolvedValue({ id: "p9", firstName: "Ada", lastName: "Lovelace", stageId: "s-open" });

    const r = await createProspects("coach-kurt", [{ firstName: "Ada", lastName: "Lovelace" }], actor);

    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.created).toHaveLength(1);
    expect(m.stageChangeCreate).toHaveBeenCalledWith({
      data: { prospectId: "p9", fromStageId: null, toStageId: "s-open", changedById: "coach-kurt" },
    });
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "PROSPECT_CREATED", actor: "user_kurt", payload: { count: 1, coachId: "coach-kurt" } })
    );
  });

  it("returns no_open_stage when the board has no open stage", async () => {
    m.stageFindFirst.mockResolvedValue(null);

    const r = await createProspects("coach-kurt", [{ firstName: "Ada", lastName: "Lovelace" }], actor);

    expect(r).toMatchObject({ ok: false, code: "no_open_stage" });
  });

  it("fails a nameless row without creating it, and does not audit an empty batch", async () => {
    const r = await createProspects("coach-kurt", [{ firstName: "", lastName: "" }], actor);

    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.created).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
    expect(m.prospectCreate).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });
});
