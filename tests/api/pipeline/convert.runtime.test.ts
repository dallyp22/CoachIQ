import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

/**
 * Convert-to-client, against a real database.
 *
 * These are integration tests on purpose. Convert is the only route that mints
 * a billable record, and the transaction boundary IS the behavior — a mocked
 * Prisma cannot prove a rollback, so unit tests here would assert the shape of
 * the code rather than the guarantee. A half-fired convert leaves a prospect
 * marked won with no client behind it, and the billing crons never see it.
 *
 *   DATABASE_URL="postgres://…" PIPELINE_RUNTIME_TESTS=1 npx vitest run tests/api/pipeline
 */

const ENABLED = process.env.PIPELINE_RUNTIME_TESTS === "1" && !!process.env.DATABASE_URL;

const currentUserId = { value: "user_todd" };
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: currentUserId.value }),
  currentUser: async () => ({ id: currentUserId.value, emailAddresses: [] }),
}));

/**
 * Fail the audit write on demand. logEvent runs inside convert's transaction
 * AFTER both the client create and the prospect link, so throwing there is the
 * cleanest way to prove the whole transaction unwinds — and it exercises the
 * real Prisma transaction rather than a stubbed one.
 */
const failAudit = { value: false };
vi.mock("@/lib/billing/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/audit")>();
  return {
    ...actual,
    logEvent: async (...args: Parameters<typeof actual.logEvent>) => {
      if (failAudit.value) throw new Error("simulated failure after client create");
      return actual.logEvent(...args);
    },
  };
});

let prisma: typeof import("@/lib/db").prisma;
let convertRoute: typeof import("@/app/api/pipeline/prospects/[id]/convert/route");
let stageRoute: typeof import("@/app/api/pipeline/prospects/[id]/stage/route");

let toddId: string;
let openStageId: string;
let wonStageId: string;

const jsonReq = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as never;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Count only clients this suite created.
 *
 * The test branch is a CLONE OF PRODUCTION — 86 real clients live here. A bare
 * client.count() conflates them with test rows and quietly passes or fails for
 * the wrong reason.
 */
const testClientCount = () =>
  prisma.client.count({ where: { email: { contains: "@pipeline-test" } } });

/** A prospect already sitting in the WON stage, ready to convert. */
async function wonProspect(over: Record<string, unknown> = {}) {
  return prisma.prospect.create({
    data: {
      coachId: toddId,
      firstName: "Won",
      lastName: "Deal",
      needSummary: "Wants exec coaching for a new VP",
      stageId: wonStageId,
      ...over,
    },
    select: { id: true, email: true },
  });
}

describe.skipIf(!ENABLED)("POST /prospects/[id]/convert", () => {
  beforeAll(async () => {
    prisma = (await import("@/lib/db")).prisma;
    convertRoute = await import("@/app/api/pipeline/prospects/[id]/convert/route");
    stageRoute = await import("@/app/api/pipeline/prospects/[id]/stage/route");
  }, 60_000);

  beforeEach(async () => {
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
        defaultHourlyRate: "350",
      },
      select: { id: true },
    });
    toddId = todd.id;
    currentUserId.value = "user_todd";

    const stages = await prisma.pipelineStage.findMany({
      where: { isArchived: false },
      orderBy: { sortOrder: "asc" },
      select: { id: true, terminal: true },
    });
    openStageId = stages.find((s) => s.terminal === null)!.id;
    wonStageId = stages.find((s) => s.terminal === "WON")!.id;
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe("happy path", () => {
    it("creates a client and links the prospect to it", async () => {
      const p = await wonProspect({ email: "won@pipeline-test.local", company: "Acme" });
      const res = await convertRoute.POST(jsonReq({}), params(p.id));

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.status).toBe("created");

      const client = await prisma.client.findUnique({ where: { id: body.clientId } });
      expect(client?.email).toBe("won@pipeline-test.local");
      expect(client?.company).toBe("Acme");
      expect(client?.status).toBe("ACTIVE");

      const after = await prisma.prospect.findUnique({ where: { id: p.id } });
      expect(after?.convertedToClientId).toBe(body.clientId);
    });

    it("carries needSummary onto the client", async () => {
      // The whole reason Client.needSummary was added: the "description of
      // need" has to survive into the coaching relationship.
      const p = await wonProspect({ email: "need@pipeline-test.local" });
      const res = await convertRoute.POST(jsonReq({}), params(p.id));
      const { clientId } = await res.json();

      const client = await prisma.client.findUnique({ where: { id: clientId } });
      expect(client?.needSummary).toBe("Wants exec coaching for a new VP");
    });

    it("defaults the rate from the owning coach", async () => {
      const p = await wonProspect({ email: "rate@pipeline-test.local" });
      const res = await convertRoute.POST(jsonReq({}), params(p.id));
      const { clientId } = await res.json();

      const client = await prisma.client.findUnique({ where: { id: clientId } });
      expect(Number(client?.hourlyRate)).toBe(350);
    });

    it("writes an audit row", async () => {
      const p = await wonProspect({ email: "audit@pipeline-test.local" });
      await convertRoute.POST(jsonReq({}), params(p.id));

      const log = await prisma.billingAuditLog.findFirst({
        where: { event: "PROSPECT_CONVERTED" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect((log?.payload as { prospectId?: string })?.prospectId).toBe(p.id);
    });
  });

  describe("the missing email (§13.2)", () => {
    it("refuses with a named error rather than writing an empty string", async () => {
      // Client.email is required and unique per coach. An empty string here
      // would make the SECOND email-less conversion collide, and the duplicate
      // handler would then offer to link two unrelated people.
      const p = await wonProspect({ email: null });
      const res = await convertRoute.POST(jsonReq({}), params(p.id));

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("email_required");
      expect(await prisma.client.count({ where: { email: "" } })).toBe(0);
    });

    it("accepts an address supplied at conversion time", async () => {
      // The import path creates prospects with no email on purpose; this is
      // where the address arrives.
      const p = await wonProspect({ email: null });
      const res = await convertRoute.POST(
        jsonReq({ email: "Supplied@Pipeline-Test.local" }),
        params(p.id),
      );

      expect(res.status).toBe(201);
      const { clientId } = await res.json();
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      expect(client?.email).toBe("supplied@pipeline-test.local");
    });

    it("still refuses a blank or whitespace-only supplied address", async () => {
      const p = await wonProspect({ email: null });
      for (const email of ["", "   ", "not-an-email"]) {
        const res = await convertRoute.POST(jsonReq({ email }), params(p.id));
        expect(res.status).toBe(422);
      }
      expect(await testClientCount()).toBe(0);
    });
  });

  describe("duplicate email (§13.2)", () => {
    it("409s with the existing client rather than guessing", async () => {
      const existing = await prisma.client.create({
        data: { coachId: toddId, name: "Existing Person", email: "dupe@pipeline-test.local" },
        select: { id: true },
      });
      const p = await wonProspect({ email: "dupe@pipeline-test.local" });

      const res = await convertRoute.POST(jsonReq({}), params(p.id));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("duplicate_email");
      expect(body.existingClient.id).toBe(existing.id);

      // Nothing written — the human decides whether this is a returning
      // client or a typo.
      const after = await prisma.prospect.findUnique({ where: { id: p.id } });
      expect(after?.convertedToClientId).toBeNull();
    });

    it("finds a CHURNED client — the duplicate check must not filter on status", async () => {
      // Client deletion is a soft flip to CHURNED and the row keeps its email.
      // A status-filtered lookup finds nothing, falls through to create, and
      // hits the unique index anyway — the exact failure the check exists to
      // prevent.
      await prisma.client.create({
        data: {
          coachId: toddId,
          name: "Former Client",
          email: "churned@pipeline-test.local",
          status: "CHURNED",
        },
      });
      const p = await wonProspect({ email: "churned@pipeline-test.local" });

      const res = await convertRoute.POST(jsonReq({}), params(p.id));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("duplicate_email");
    });

    it("links to the existing client when the caller confirms", async () => {
      const existing = await prisma.client.create({
        data: { coachId: toddId, name: "Returning", email: "link@pipeline-test.local" },
        select: { id: true },
      });
      const p = await wonProspect({ email: "link@pipeline-test.local" });

      const before = await testClientCount();
      const res = await convertRoute.POST(
        jsonReq({ linkToExistingClientId: existing.id }),
        params(p.id),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.status).toBe("linked");
      expect(body.clientId).toBe(existing.id);
      // Linked, not duplicated.
      expect(await testClientCount()).toBe(before);

      const after = await prisma.prospect.findUnique({ where: { id: p.id } });
      expect(after?.convertedToClientId).toBe(existing.id);
    });

    it("refuses a link to a client that is not the email match", async () => {
      const other = await prisma.client.create({
        data: { coachId: toddId, name: "Unrelated", email: "other@pipeline-test.local" },
        select: { id: true },
      });
      await prisma.client.create({
        data: { coachId: toddId, name: "Match", email: "match@pipeline-test.local" },
      });
      const p = await wonProspect({ email: "match@pipeline-test.local" });

      const res = await convertRoute.POST(
        jsonReq({ linkToExistingClientId: other.id }),
        params(p.id),
      );
      expect(res.status).toBe(409);
    });

    it("allows the same email in a DIFFERENT coach's book", async () => {
      // Two coaches may legitimately serve the same person — the unique index
      // is (coachId, email), not email.
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
      await prisma.client.create({
        data: { coachId: kurt.id, name: "Shared Person", email: "shared@pipeline-test.local" },
      });

      const p = await wonProspect({ email: "shared@pipeline-test.local" });
      const res = await convertRoute.POST(jsonReq({}), params(p.id));
      expect(res.status).toBe(201);
    });
  });

  describe("idempotency", () => {
    it("does not mint a second client on a double-submit", async () => {
      const p = await wonProspect({ email: "double@pipeline-test.local" });

      const first = await convertRoute.POST(jsonReq({}), params(p.id));
      expect(first.status).toBe(201);
      const { clientId } = await first.json();

      const second = await convertRoute.POST(jsonReq({}), params(p.id));
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.status).toBe("already_converted");
      expect(body.clientId).toBe(clientId);

      expect(await prisma.client.count({ where: { email: "double@pipeline-test.local" } })).toBe(1);
    });

    it("survives two concurrent converts without creating two clients", async () => {
      // The race the pre-check cannot close: both requests read "no existing
      // client", both proceed. The unique index is the real guard.
      const p = await wonProspect({ email: "race@pipeline-test.local" });

      const results = await Promise.allSettled([
        convertRoute.POST(jsonReq({}), params(p.id)),
        convertRoute.POST(jsonReq({}), params(p.id)),
      ]);
      const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 500));

      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      expect(await prisma.client.count({ where: { email: "race@pipeline-test.local" } })).toBe(1);
    });
  });

  describe("rollback — the reason these are integration tests", () => {
    it("leaves NO client behind when the prospect update fails mid-transaction", async () => {
      const p = await wonProspect({ email: "rollback@pipeline-test.local" });
      const before = await testClientCount();

      // Inside the transaction: create the client, link the prospect, write
      // the audit row. Fail the LAST step and all three must unwind. Without a
      // transaction the client would survive as an orphan — a billable record
      // with nothing pointing at it, invisible to the pipeline and live to the
      // billing crons.
      failAudit.value = true;
      try {
        await expect(convertRoute.POST(jsonReq({}), params(p.id))).rejects.toThrow(
          /simulated failure/,
        );
      } finally {
        failAudit.value = false;
      }

      expect(await testClientCount()).toBe(before);
      expect(
        await prisma.client.count({ where: { email: "rollback@pipeline-test.local" } }),
      ).toBe(0);

      // And the prospect is still unconverted, so it can be retried.
      const after = await prisma.prospect.findUnique({ where: { id: p.id } });
      expect(after?.convertedToClientId).toBeNull();
    });
  });

  describe("stage gating", () => {
    it("refuses to convert a prospect that is not in a won stage", async () => {
      const p = await prisma.prospect.create({
        data: { coachId: toddId, firstName: "Open", lastName: "Lead", stageId: openStageId, email: "open@pipeline-test.local" },
        select: { id: true },
      });
      const res = await convertRoute.POST(jsonReq({}), params(p.id));
      expect(res.status).toBe(400);
      expect(await testClientCount()).toBe(0);
    });

    it("a stage move to WON does not itself create a client", async () => {
      // Convert is a separate, explicit call. A stage move must never silently
      // mint a billable record — nor silently fail to.
      const p = await prisma.prospect.create({
        data: { coachId: toddId, firstName: "Moving", lastName: "Won", stageId: openStageId, email: "moving@pipeline-test.local" },
        select: { id: true },
      });
      const res = await stageRoute.POST(jsonReq({ stageId: wonStageId }), params(p.id));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.convertAvailable).toBe(true);
      expect(await testClientCount()).toBe(0);

      const after = await prisma.prospect.findUnique({ where: { id: p.id } });
      expect(after?.convertedToClientId).toBeNull();
    });
  });
});
