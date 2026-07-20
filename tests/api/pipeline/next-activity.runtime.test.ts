import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Prospect.nextActivityAt, across every write path that can change it.
 *
 * This column is the module's one denormalization, and its failure mode is
 * SILENT: no error, just a list sorted wrongly, which nobody can falsify from
 * the UI. The review named it the carried risk of the whole build. So every
 * path gets a test, including the two that are easy to forget — PATCH
 * (rescheduling changes which activity is soonest without creating or
 * deleting anything) and the terminal stage move (a closed prospect must stop
 * nagging).
 *
 *   DATABASE_URL="postgres://…" PIPELINE_RUNTIME_TESTS=1 npx vitest run tests/api/pipeline
 */

const ENABLED = process.env.PIPELINE_RUNTIME_TESTS === "1" && !!process.env.DATABASE_URL;

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_todd" }),
  currentUser: async () => ({ id: "user_todd", emailAddresses: [] }),
}));

let prisma: typeof import("@/lib/db").prisma;
let activitiesRoute: typeof import("@/app/api/pipeline/activities/route");
let stageRoute: typeof import("@/app/api/pipeline/prospects/[id]/stage/route");
let prospectsRoute: typeof import("@/app/api/pipeline/prospects/route");

let toddId: string;
let openStageId: string;
let wonStageId: string;
let lostStageId: string;
let prospectId: string;

const jsonReq = (body: unknown, method = "POST") =>
  new NextRequest("http://localhost/x", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  } as never) as never;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const nextOf = async (id = prospectId) =>
  (await prisma.prospect.findUnique({ where: { id }, select: { nextActivityAt: true } }))
    ?.nextActivityAt ?? null;

const plan = (whenISO: string) =>
  activitiesRoute.POST(jsonReq({ prospectId, kind: "PLANNED", activityAt: whenISO }));

describe.skipIf(!ENABLED)("Prospect.nextActivityAt maintenance", () => {
  beforeAll(async () => {
    prisma = (await import("@/lib/db")).prisma;
    activitiesRoute = await import("@/app/api/pipeline/activities/route");
    stageRoute = await import("@/app/api/pipeline/prospects/[id]/stage/route");
    prospectsRoute = await import("@/app/api/pipeline/prospects/route");
  }, 60_000);

  beforeEach(async () => {
    await prisma.pipelineActivity.deleteMany({});
    await prisma.prospectStageChange.deleteMany({});
    await prisma.prospect.deleteMany({});
    await prisma.coach.deleteMany({ where: { loginEmail: { contains: "@pipeline-test" } } });

    const todd = await prisma.coach.create({
      data: {
        name: "Todd (test)",
        loginEmail: "todd@pipeline-test.local",
        clerkUserId: "user_todd",
        role: "OWNER",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    toddId = todd.id;

    const stages = await prisma.pipelineStage.findMany({
      where: { isArchived: false },
      orderBy: { sortOrder: "asc" },
      select: { id: true, terminal: true },
    });
    openStageId = stages.find((s) => s.terminal === null)!.id;
    wonStageId = stages.find((s) => s.terminal === "WON")!.id;
    lostStageId = stages.find((s) => s.terminal === "LOST")!.id;

    const p = await prisma.prospect.create({
      data: { coachId: toddId, firstName: "Test", lastName: "Lead", stageId: openStageId },
      select: { id: true },
    });
    prospectId = p.id;
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("starts null — a new prospect has nothing scheduled", async () => {
    expect(await nextOf()).toBeNull();
  });

  it("is set when a PLANNED activity is created", async () => {
    await plan("2026-08-01T15:00:00.000Z");
    expect((await nextOf())?.toISOString()).toBe("2026-08-01T15:00:00.000Z");
  });

  it("is NOT set by a LOGGED activity — that already happened", async () => {
    await activitiesRoute.POST(
      jsonReq({ prospectId, kind: "LOGGED", activityAt: "2026-08-01T15:00:00.000Z" }),
    );
    expect(await nextOf()).toBeNull();
  });

  it("holds the SOONEST plan, not the most recently created", async () => {
    await plan("2026-09-01T15:00:00.000Z");
    await plan("2026-08-01T15:00:00.000Z");
    expect((await nextOf())?.toISOString()).toBe("2026-08-01T15:00:00.000Z");
  });

  describe("PATCH — the path that hides", () => {
    it("follows a reschedule forward", async () => {
      // Rescheduling is neither a create nor a delete. Miss it and the row
      // displays the new date while sorting by the old one.
      const res = await plan("2026-08-01T15:00:00.000Z");
      const { activity } = await res.json();

      await activitiesRoute.PATCH(
        jsonReq({ id: activity.id, activityAt: "2026-08-20T15:00:00.000Z" }, "PATCH"),
      );
      expect((await nextOf())?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
    });

    it("follows a reschedule that changes WHICH activity is next", async () => {
      const soon = await (await plan("2026-08-01T15:00:00.000Z")).json();
      await plan("2026-09-01T15:00:00.000Z");
      expect((await nextOf())?.toISOString()).toBe("2026-08-01T15:00:00.000Z");

      // Push the near one past the far one — the far one becomes next.
      await activitiesRoute.PATCH(
        jsonReq({ id: soon.activity.id, activityAt: "2026-10-01T15:00:00.000Z" }, "PATCH"),
      );
      expect((await nextOf())?.toISOString()).toBe("2026-09-01T15:00:00.000Z");
    });

    it("clears it when the only plan is completed", async () => {
      const { activity } = await (await plan("2026-08-01T15:00:00.000Z")).json();
      await activitiesRoute.PATCH(jsonReq({ id: activity.id, completed: true }, "PATCH"));
      expect(await nextOf()).toBeNull();
    });

    it("promotes the next-next plan when one is completed", async () => {
      const first = await (await plan("2026-08-01T15:00:00.000Z")).json();
      await plan("2026-09-01T15:00:00.000Z");

      await activitiesRoute.PATCH(jsonReq({ id: first.activity.id, completed: true }, "PATCH"));
      expect((await nextOf())?.toISOString()).toBe("2026-09-01T15:00:00.000Z");
    });

    it("restores it when a completed plan is re-opened", async () => {
      const { activity } = await (await plan("2026-08-01T15:00:00.000Z")).json();
      await activitiesRoute.PATCH(jsonReq({ id: activity.id, completed: true }, "PATCH"));
      expect(await nextOf()).toBeNull();

      await activitiesRoute.PATCH(jsonReq({ id: activity.id, completed: false }, "PATCH"));
      expect((await nextOf())?.toISOString()).toBe("2026-08-01T15:00:00.000Z");
    });
  });

  describe("DELETE", () => {
    it("clears it when the only plan is deleted", async () => {
      const { activity } = await (await plan("2026-08-01T15:00:00.000Z")).json();
      await activitiesRoute.DELETE(
        new NextRequest(`http://localhost/x?id=${activity.id}`, { method: "DELETE" }) as never,
      );
      expect(await nextOf()).toBeNull();
    });

    it("promotes the next-next plan when the soonest is deleted", async () => {
      const first = await (await plan("2026-08-01T15:00:00.000Z")).json();
      await plan("2026-09-01T15:00:00.000Z");

      await activitiesRoute.DELETE(
        new NextRequest(`http://localhost/x?id=${first.activity.id}`, { method: "DELETE" }) as never,
      );
      expect((await nextOf())?.toISOString()).toBe("2026-09-01T15:00:00.000Z");
    });
  });

  describe("terminal stage moves", () => {
    it("clears it when a prospect is won", async () => {
      // A closed-won prospect keeping a dangling future plan would stay
      // eligible for the overdue-amber state — nagging about a finished deal.
      await plan("2026-08-01T15:00:00.000Z");
      await stageRoute.POST(jsonReq({ stageId: wonStageId }), params(prospectId));
      expect(await nextOf()).toBeNull();
    });

    it("clears it when a prospect is lost", async () => {
      await plan("2026-08-01T15:00:00.000Z");
      await stageRoute.POST(
        jsonReq({ stageId: lostStageId, lostReason: "Went with a competitor" }),
        params(prospectId),
      );
      expect(await nextOf()).toBeNull();
    });

    it("leaves it alone on a move between open stages", async () => {
      const stages = await prisma.pipelineStage.findMany({
        where: { isArchived: false, terminal: null },
        orderBy: { sortOrder: "asc" },
        select: { id: true },
      });
      await plan("2026-08-01T15:00:00.000Z");
      await stageRoute.POST(jsonReq({ stageId: stages[1].id }), params(prospectId));
      expect((await nextOf())?.toISOString()).toBe("2026-08-01T15:00:00.000Z");
    });
  });

  describe("the sort it exists to serve", () => {
    it("puts never-touched prospects ABOVE scheduled ones", async () => {
      // Postgres sorts ASC as NULLS LAST. If STALEST_FIRST ever loses its
      // explicit nulls:"first", this is the test that catches it — and the
      // symptom in production would be silent: the neglected prospects the
      // module exists to surface, quietly at the bottom of the list.
      await plan("2026-12-01T15:00:00.000Z"); // scheduled far out
      const overdue = await prisma.prospect.create({
        data: {
          coachId: toddId,
          firstName: "Overdue",
          lastName: "Lead",
          stageId: openStageId,
          nextActivityAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        select: { id: true },
      });
      const untouched = await prisma.prospect.create({
        data: { coachId: toddId, firstName: "Untouched", lastName: "Lead", stageId: openStageId },
        select: { id: true },
      });

      const res = await prospectsRoute.GET(
        new NextRequest("http://localhost/api/pipeline/prospects") as never,
      );
      const body = await res.json();
      const order = body.prospects.map((p: { id: string }) => p.id);

      expect(order[0]).toBe(untouched.id);
      expect(order.indexOf(untouched.id)).toBeLessThan(order.indexOf(overdue.id));
      expect(order.indexOf(overdue.id)).toBeLessThan(order.indexOf(prospectId));
    });
  });

  /**
   * Regression tests for two bugs the pre-merge review found. Both were SILENT —
   * no error, just a wrong sort order — which is exactly why neither was caught
   * by the original suite.
   */
  describe("stage-awareness regressions (found in pre-merge review)", () => {
    it("recomputes when a CLOSED prospect is reopened", async () => {
      // The bug: the terminal branch cleared nextActivityAt with no else, so
      // reopening left it null forever while real planned activities sat
      // underneath. The row claimed "none scheduled" at the top of the
      // stalest-first list while its own dossier showed a booked call.
      await plan("2026-08-01T15:00:00.000Z");
      await stageRoute.POST(
        jsonReq({ stageId: lostStageId, lostReason: "Budget cut" }),
        params(prospectId),
      );
      expect(await nextOf()).toBeNull();

      await stageRoute.POST(jsonReq({ stageId: openStageId }), params(prospectId));
      expect((await nextOf())?.toISOString()).toBe("2026-08-01T15:00:00.000Z");
    });

    it("does NOT re-arm a closed prospect when an unrelated activity is touched", async () => {
      // The mirror bug: refreshNextActivityAt was stage-blind, so ANY later
      // activity mutation — even deleting a different activity — put a date back
      // on a won deal and resumed the overdue nagging that closing it stopped.
      await plan("2026-08-01T15:00:00.000Z");
      const other = await (await plan("2026-09-01T15:00:00.000Z")).json();

      await stageRoute.POST(jsonReq({ stageId: wonStageId }), params(prospectId));
      expect(await nextOf()).toBeNull();

      await activitiesRoute.DELETE(
        new NextRequest(`http://localhost/x?id=${other.activity.id}`, { method: "DELETE" }) as never,
      );
      expect(await nextOf()).toBeNull();

      await activitiesRoute.POST(
        jsonReq({ prospectId, kind: "PLANNED", activityAt: "2026-10-01T15:00:00.000Z" }),
      );
      expect(await nextOf()).toBeNull();
    });
  });

  describe("stage-move guards (found untested in pre-merge review)", () => {
    it("refuses a move to a lost stage with no reason, and does not move the prospect", async () => {
      const before = await prisma.prospect.findUnique({ where: { id: prospectId } });
      const res = await stageRoute.POST(jsonReq({ stageId: lostStageId }), params(prospectId));
      expect(res.status).toBe(400);
      const after = await prisma.prospect.findUnique({ where: { id: prospectId } });
      expect(after?.stageId).toBe(before?.stageId);
    });

    it("refuses a whitespace-only reason", async () => {
      const res = await stageRoute.POST(
        jsonReq({ stageId: lostStageId, lostReason: "   " }),
        params(prospectId),
      );
      expect(res.status).toBe(400);
    });

    it("clears a stale lostReason when the prospect is reopened", async () => {
      await stageRoute.POST(
        jsonReq({ stageId: lostStageId, lostReason: "Went with a competitor" }),
        params(prospectId),
      );
      await stageRoute.POST(jsonReq({ stageId: openStageId }), params(prospectId));
      const after = await prisma.prospect.findUnique({ where: { id: prospectId } });
      expect(after?.lostReason).toBeNull();
    });

    it("treats a move to the current stage as unchanged and writes no history row", async () => {
      const current = (await prisma.prospect.findUnique({ where: { id: prospectId } }))!.stageId;
      const before = await prisma.prospectStageChange.count({ where: { prospectId } });
      const res = await stageRoute.POST(jsonReq({ stageId: current }), params(prospectId));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("unchanged");
      expect(await prisma.prospectStageChange.count({ where: { prospectId } })).toBe(before);
    });

    it("rejects a malformed request body with 400, not 500", async () => {
      const bad = new NextRequest("http://localhost/x", {
        method: "POST",
        body: "not json at all",
        headers: { "content-type": "application/json" },
      } as never) as never;
      const res = await stageRoute.POST(bad, params(prospectId));
      expect(res.status).toBe(400);
    });
  });

  describe("POST /prospects stage validation (found in pre-merge review)", () => {
    it("refuses to create a prospect directly in a TERMINAL stage", async () => {
      // The worst finding of the review: creating straight into WON let convert
      // mint a billable Client without ever passing the stage route — no history,
      // no audit, no lostReason enforcement.
      const res = await prospectsRoute.POST(
        jsonReq({ firstName: "Sneaky", lastName: "Win", stageId: wonStageId }),
      );
      const body = await res.json();
      expect(body.created).toHaveLength(0);
      expect(await prisma.prospect.count({ where: { firstName: "Sneaky" } })).toBe(0);
    });

    it("refuses to create a prospect in an ARCHIVED stage", async () => {
      const spare = await prisma.pipelineStage.create({
        data: { name: "Spare (test)", sortOrder: 99, isArchived: true, updatedAt: new Date() },
        select: { id: true },
      });
      const res = await prospectsRoute.POST(
        jsonReq({ firstName: "Hidden", lastName: "Row", stageId: spare.id }),
      );
      const body = await res.json();
      expect(body.created).toHaveLength(0);
      expect(await prisma.prospect.count({ where: { firstName: "Hidden" } })).toBe(0);
      await prisma.pipelineStage.delete({ where: { id: spare.id } });
    });

    it("refuses an unknown assignedCoachId instead of injecting onto a real board", async () => {
      const res = await prospectsRoute.POST(
        jsonReq({
          firstName: "Injected",
          lastName: "Row",
          assignedCoachId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      const body = await res.json();
      expect(body.created).toHaveLength(0);
      expect(await prisma.prospect.count({ where: { firstName: "Injected" } })).toBe(0);
    });

    it("still accepts a valid open stage", async () => {
      const res = await prospectsRoute.POST(
        jsonReq({ firstName: "Normal", lastName: "Lead", stageId: openStageId }),
      );
      expect(res.status).toBe(201);
      expect(await prisma.prospect.count({ where: { firstName: "Normal" } })).toBe(1);
    });
  });
});
