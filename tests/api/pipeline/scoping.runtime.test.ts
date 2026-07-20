import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * RUNTIME cross-coach isolation for every pipeline route.
 *
 * Why these exist: tests/lib/scoping-enforcement.test.ts checks that a route
 * calls requireCoach and nothing more — by its own header it "never asks what
 * the file touches". A route that authenticates and then runs
 * `prisma.prospect.findMany({})` with no where-clause passes it. That exact
 * blindness is how invoices/generate and calendar/sync shipped unscoped.
 *
 * So these do not test a proxy for isolation. They seed two coaches with real
 * rows in a real database, call the real handlers as each coach, and assert
 * one cannot see or touch the other's prospects.
 *
 * Needs a throwaway database:
 *   DATABASE_URL="postgres://…"  PIPELINE_RUNTIME_TESTS=1 npx vitest run tests/api/pipeline
 * Skipped otherwise, so the default suite stays hermetic and offline.
 */

const ENABLED = process.env.PIPELINE_RUNTIME_TESTS === "1" && !!process.env.DATABASE_URL;

// Clerk is the only thing stubbed. requireCoach() then does its real work:
// resolving that userId to a coach row in the real database.
const currentUserId = { value: "user_todd" };
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: currentUserId.value }),
  currentUser: async () => ({ id: currentUserId.value, emailAddresses: [] }),
}));

const asCoach = (userId: string) => {
  currentUserId.value = userId;
};

type Ids = {
  todd: string;
  kurt: string;
  openStage: string;
  secondStage: string;
  wonStage: string;
  lostStage: string;
  toddProspect: string;
  kurtProspect: string;
  assignedToKurt: string;
};

let prisma: typeof import("@/lib/db").prisma;
let ids: Ids;

// Route handlers, imported after the Clerk mock is registered.
let prospectsRoute: typeof import("@/app/api/pipeline/prospects/route");
let prospectRoute: typeof import("@/app/api/pipeline/prospects/[id]/route");
let stageRoute: typeof import("@/app/api/pipeline/prospects/[id]/stage/route");
let convertRoute: typeof import("@/app/api/pipeline/prospects/[id]/convert/route");
let activitiesRoute: typeof import("@/app/api/pipeline/activities/route");
let stagesRoute: typeof import("@/app/api/pipeline/stages/route");
let summaryRoute: typeof import("@/app/api/pipeline/reports/summary/route");

// Routes read request.nextUrl.searchParams; a plain Request has no nextUrl.
const req = (url: string, init?: RequestInit) =>
  new NextRequest(`http://localhost${url}`, init as never) as never;

const jsonReq = (url: string, body: unknown, method = "POST") =>
  req(url, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!ENABLED)("pipeline routes — cross-coach isolation", () => {
  beforeAll(async () => {
    prisma = (await import("@/lib/db")).prisma;
    prospectsRoute = await import("@/app/api/pipeline/prospects/route");
    prospectRoute = await import("@/app/api/pipeline/prospects/[id]/route");
    stageRoute = await import("@/app/api/pipeline/prospects/[id]/stage/route");
    convertRoute = await import("@/app/api/pipeline/prospects/[id]/convert/route");
    activitiesRoute = await import("@/app/api/pipeline/activities/route");
    stagesRoute = await import("@/app/api/pipeline/stages/route");
    summaryRoute = await import("@/app/api/pipeline/reports/summary/route");
  }, 60_000);

  beforeEach(async () => {
    // Full reset so no test depends on another's leftovers.
    await prisma.pipelineActivity.deleteMany({});
    await prisma.prospectStageChange.deleteMany({});
    await prisma.prospect.deleteMany({});
    await prisma.client.deleteMany({ where: { email: { contains: "@pipeline-test" } } });
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
    const kurt = await prisma.coach.create({
      data: {
        name: "Kurt (test)",
        loginEmail: "kurt@pipeline-test.local",
        clerkUserId: "user_kurt",
        role: "COACH",
        status: "ACTIVE",
      },
      select: { id: true },
    });

    const stages = await prisma.pipelineStage.findMany({
      where: { isArchived: false },
      orderBy: { sortOrder: "asc" },
      select: { id: true, terminal: true },
    });
    const open = stages.filter((s) => s.terminal === null);

    const toddProspect = await prisma.prospect.create({
      data: { coachId: todd.id, firstName: "Todd", lastName: "Lead", stageId: open[0].id },
      select: { id: true },
    });
    const kurtProspect = await prisma.prospect.create({
      data: { coachId: kurt.id, firstName: "Kurt", lastName: "Lead", stageId: open[0].id },
      select: { id: true },
    });
    // Owned by Todd, assigned to Kurt — the case a single-column filter breaks.
    const assignedToKurt = await prisma.prospect.create({
      data: {
        coachId: todd.id,
        assignedCoachId: kurt.id,
        firstName: "Handed",
        lastName: "Off",
        stageId: open[0].id,
      },
      select: { id: true },
    });

    ids = {
      todd: todd.id,
      kurt: kurt.id,
      openStage: open[0].id,
      secondStage: open[1].id,
      wonStage: stages.find((s) => s.terminal === "WON")!.id,
      lostStage: stages.find((s) => s.terminal === "LOST")!.id,
      toddProspect: toddProspect.id,
      kurtProspect: kurtProspect.id,
      assignedToKurt: assignedToKurt.id,
    };

    asCoach("user_todd");
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe("GET /prospects — the list", () => {
    it("shows a COACH only their own and their assigned prospects", async () => {
      asCoach("user_kurt");
      const res = await prospectsRoute.GET(req("/api/pipeline/prospects"));
      const body = await res.json();

      const returned = body.prospects.map((p: { id: string }) => p.id).sort();
      expect(returned).toEqual([ids.assignedToKurt, ids.kurtProspect].sort());
      expect(returned).not.toContain(ids.toddProspect);
    });

    it("includes the prospect assigned to them but owned by someone else", async () => {
      // The regression this pins: filtering on coachId alone would give Kurt
      // an empty-ish list while Todd's UI shows "Assigned: Kurt".
      asCoach("user_kurt");
      const res = await prospectsRoute.GET(req("/api/pipeline/prospects"));
      const body = await res.json();
      expect(body.prospects.map((p: { id: string }) => p.id)).toContain(ids.assignedToKurt);
    });

    it("shows an OWNER every prospect in the practice", async () => {
      asCoach("user_todd");
      const res = await prospectsRoute.GET(req("/api/pipeline/prospects"));
      const body = await res.json();
      expect(body.prospects).toHaveLength(3);
    });

    it("ignores a coachId override from a COACH", async () => {
      // scopeCoachId pins a COACH to themselves; no query-string fiddling
      // widens the view.
      asCoach("user_kurt");
      const res = await prospectsRoute.GET(req(`/api/pipeline/prospects?coachId=${ids.todd}`));
      const body = await res.json();
      expect(body.prospects.map((p: { id: string }) => p.id)).not.toContain(ids.toddProspect);
    });

    it("counts only what the caller may see", async () => {
      // `total` drives pagination. Leaking the practice-wide count would tell
      // Kurt how many prospects exist that he cannot see.
      asCoach("user_kurt");
      const res = await prospectsRoute.GET(req("/api/pipeline/prospects"));
      const body = await res.json();
      expect(body.total).toBe(2);
    });
  });

  describe("GET /prospects/[id] — the dossier", () => {
    it("404s on another coach's prospect rather than 403", async () => {
      asCoach("user_kurt");
      const res = await prospectRoute.GET(req("/x"), params(ids.toddProspect));
      expect(res.status).toBe(404);
      // 403 would confirm the row exists, which is itself a disclosure.
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("forbidden");
    });

    it("opens a prospect assigned to them", async () => {
      asCoach("user_kurt");
      const res = await prospectRoute.GET(req("/x"), params(ids.assignedToKurt));
      expect(res.status).toBe(200);
    });
  });

  describe("mutations refuse another coach's prospect", () => {
    it("PATCH 404s", async () => {
      asCoach("user_kurt");
      const res = await prospectRoute.PATCH(
        jsonReq("/x", { company: "Hijacked" }, "PATCH"),
        params(ids.toddProspect),
      );
      expect(res.status).toBe(404);
      const row = await prisma.prospect.findUnique({ where: { id: ids.toddProspect } });
      expect(row?.company).toBeNull();
    });

    it("DELETE 404s and leaves the row intact", async () => {
      asCoach("user_kurt");
      const res = await prospectRoute.DELETE(req("/x", { method: "DELETE" }), params(ids.toddProspect));
      expect(res.status).toBe(404);
      expect(await prisma.prospect.findUnique({ where: { id: ids.toddProspect } })).not.toBeNull();
    });

    it("stage move 404s", async () => {
      asCoach("user_kurt");
      const res = await stageRoute.POST(
        jsonReq("/x", { stageId: ids.secondStage }),
        params(ids.toddProspect),
      );
      expect(res.status).toBe(404);
      const row = await prisma.prospect.findUnique({ where: { id: ids.toddProspect } });
      expect(row?.stageId).toBe(ids.openStage);
    });

    it("convert 404s and mints no client", async () => {
      asCoach("user_kurt");
      const before = await prisma.client.count();
      const res = await convertRoute.POST(
        jsonReq("/x", { email: "stolen@pipeline-test.local" }),
        params(ids.toddProspect),
      );
      expect(res.status).toBe(404);
      expect(await prisma.client.count()).toBe(before);
    });

    it("activity create 404s on another coach's prospect", async () => {
      asCoach("user_kurt");
      const res = await activitiesRoute.POST(
        jsonReq("/x", { prospectId: ids.toddProspect, kind: "LOGGED" }),
      );
      expect(res.status).toBe(404);
      expect(await prisma.pipelineActivity.count()).toBe(0);
    });

    it("activity PATCH 404s on an activity belonging to another coach's prospect", async () => {
      // The indirect path: the activity id is guessable, and the activity
      // itself carries no coach — authorization has to hop to the prospect.
      const activity = await prisma.pipelineActivity.create({
        data: { prospectId: ids.toddProspect, kind: "PLANNED", activityAt: new Date() },
        select: { id: true },
      });
      asCoach("user_kurt");
      const res = await activitiesRoute.PATCH(
        jsonReq("/x", { id: activity.id, notes: "hijacked" }, "PATCH"),
      );
      expect(res.status).toBe(404);
      const row = await prisma.pipelineActivity.findUnique({ where: { id: activity.id } });
      expect(row?.notes).toBeNull();
    });

    it("activity DELETE 404s on another coach's activity", async () => {
      const activity = await prisma.pipelineActivity.create({
        data: { prospectId: ids.toddProspect, kind: "PLANNED", activityAt: new Date() },
        select: { id: true },
      });
      asCoach("user_kurt");
      const res = await activitiesRoute.DELETE(req(`/x?id=${activity.id}`, { method: "DELETE" }));
      expect(res.status).toBe(404);
      expect(await prisma.pipelineActivity.findUnique({ where: { id: activity.id } })).not.toBeNull();
    });
  });

  describe("POST /prospects — creation cannot be attributed elsewhere", () => {
    it("pins a COACH's new prospect to themselves even when the body names another coach", async () => {
      asCoach("user_kurt");
      const res = await prospectsRoute.POST(
        jsonReq("/x", { firstName: "New", lastName: "Lead", coachId: ids.todd }),
      );
      expect(res.status).toBe(201);
      const created = await prisma.prospect.findFirst({
        where: { firstName: "New", lastName: "Lead" },
        select: { coachId: true },
      });
      expect(created?.coachId).toBe(ids.kurt);
    });

    it("lets an OWNER create on a coach's behalf", async () => {
      asCoach("user_todd");
      await prospectsRoute.POST(
        jsonReq("/x", { firstName: "For", lastName: "Kurt", coachId: ids.kurt }),
      );
      const created = await prisma.prospect.findFirst({
        where: { firstName: "For", lastName: "Kurt" },
        select: { coachId: true },
      });
      expect(created?.coachId).toBe(ids.kurt);
    });
  });

  describe("GET /reports/summary", () => {
    it("counts only the caller's prospects", async () => {
      asCoach("user_kurt");
      const res = await summaryRoute.GET(req("/api/pipeline/reports/summary"));
      const body = await res.json();
      expect(body.summary.totalOpen).toBe(2);
    });

    it("gives an OWNER the whole practice", async () => {
      asCoach("user_todd");
      const res = await summaryRoute.GET(req("/api/pipeline/reports/summary"));
      const body = await res.json();
      expect(body.summary.totalOpen).toBe(3);
    });
  });

  describe("PATCH /stages — practice-wide config needs ADMIN", () => {
    it("refuses a plain COACH", async () => {
      // One coach renaming a column reshapes everyone's board.
      asCoach("user_kurt");
      const res = await stagesRoute.PATCH(
        jsonReq("/x", { id: ids.openStage, name: "Renamed By Kurt" }, "PATCH"),
      );
      expect(res.status).toBe(403);
      const stage = await prisma.pipelineStage.findUnique({ where: { id: ids.openStage } });
      expect(stage?.name).not.toBe("Renamed By Kurt");
    });

    it("allows an OWNER", async () => {
      asCoach("user_todd");
      const res = await stagesRoute.PATCH(
        jsonReq("/x", { id: ids.openStage, name: "Renamed By Todd" }, "PATCH"),
      );
      expect(res.status).toBe(200);
      const stage = await prisma.pipelineStage.findUnique({ where: { id: ids.openStage } });
      expect(stage?.name).toBe("Renamed By Todd");
      await prisma.pipelineStage.update({
        where: { id: ids.openStage },
        data: { name: "New Lead" },
      });
    });
  });

  describe("GET /stages — readable by any coach", () => {
    it("returns the board for a plain COACH, since it populates their dropdowns", async () => {
      asCoach("user_kurt");
      const res = await stagesRoute.GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stages.length).toBeGreaterThan(0);
    });
  });
});
