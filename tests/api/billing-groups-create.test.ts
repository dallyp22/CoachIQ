import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCoach: vi.fn(),
  coachFindUnique: vi.fn(),
  coachFindFirst: vi.fn(),
  groupCreate: vi.fn(),
  transaction: vi.fn(),
  logEvent: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  prisma: {
    coach: { findUnique: mocks.coachFindUnique, findFirst: mocks.coachFindFirst },
    billingGroup: { findMany: vi.fn() },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/billing/audit", () => ({ logEvent: mocks.logEvent, BillingEvent: { GROUP_CREATED: "GROUP_CREATED" } }));
vi.mock("@/lib/authz", () => ({
  requireCoach: mocks.requireCoach,
  scopeCoachId: (c: { role: string; id: string }) => (c.role === "COACH" ? c.id : null),
  authzResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}));

import { POST } from "@/app/api/billing-groups/route";

function req(body: unknown) {
  return new Request("http://localhost/api/billing-groups", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}
const VALID = { name: "Acme", billingContactEmail: "billing@acme.com" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user_1" });
  mocks.coachFindFirst.mockResolvedValue({ id: "coach-todd" });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ billingGroup: { create: mocks.groupCreate }, })
  );
  mocks.groupCreate.mockResolvedValue({ id: "grp_1", name: "Acme" });
});

describe("POST /api/billing-groups — who owns the group", () => {
  it("attributes an ADMIN's group to the practice owner, not to the admin", async () => {
    // Admins administer other people's books and own no clients. Attributing
    // the group to the acting admin produced a group whose member list was
    // empty and which rejected every client in the practice.
    mocks.requireCoach.mockResolvedValue({ id: "coach-dallas", role: "ADMIN" });

    await POST(req(VALID));

    expect(mocks.groupCreate.mock.calls[0][0].data.coachId).toBe("coach-todd");
  });

  it("attributes a COACH's group to that coach", async () => {
    mocks.requireCoach.mockResolvedValue({ id: "coach-kurt", role: "COACH" });
    await POST(req(VALID));
    expect(mocks.groupCreate.mock.calls[0][0].data.coachId).toBe("coach-kurt");
  });

  it("lets an ADMIN name a specific coach", async () => {
    mocks.requireCoach.mockResolvedValue({ id: "coach-dallas", role: "ADMIN" });
    mocks.coachFindUnique.mockResolvedValue({ id: "coach-kurt" });
    await POST(req({ ...VALID, coachId: "coach-kurt" }));
    expect(mocks.groupCreate.mock.calls[0][0].data.coachId).toBe("coach-kurt");
  });

  it("404s when an ADMIN names a coach that does not exist", async () => {
    mocks.requireCoach.mockResolvedValue({ id: "coach-dallas", role: "ADMIN" });
    mocks.coachFindUnique.mockResolvedValue(null);
    const res = await POST(req({ ...VALID, coachId: "ghost" }));
    expect(res.status).toBe(404);
  });

  it("a COACH cannot attribute a group to someone else via the body", async () => {
    mocks.requireCoach.mockResolvedValue({ id: "coach-kurt", role: "COACH" });
    await POST(req({ ...VALID, coachId: "coach-todd" }));
    expect(mocks.groupCreate.mock.calls[0][0].data.coachId).toBe("coach-kurt");
  });
});
