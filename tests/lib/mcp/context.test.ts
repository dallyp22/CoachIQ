import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The MCP auth bridge — the security seam every tool depends on. resolveMcpActor
 * must reject a request with no verified Clerk userId (rather than silently
 * resolving a wrong/empty coach) and otherwise pass the userId + minRole through
 * to the shared resolveCoachByUserId.
 */

const mocks = vi.hoisted(() => ({ resolveCoachByUserId: vi.fn() }));

vi.mock("@/lib/authz", async (orig) => ({
  ...(await orig<typeof import("@/lib/authz")>()),
  resolveCoachByUserId: mocks.resolveCoachByUserId,
}));

import { resolveMcpActor, resolveMcpCoach, errorResult } from "@/lib/mcp/context";
import { AuthzError } from "@/lib/authz";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveCoachByUserId.mockResolvedValue({ id: "coach-kurt", role: "COACH" });
});

describe("resolveMcpActor", () => {
  it("rejects a request with no verified userId (missing / undefined / non-string)", async () => {
    await expect(resolveMcpActor({})).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    await expect(resolveMcpActor(undefined)).rejects.toMatchObject({ status: 401 });
    await expect(
      resolveMcpActor({ authInfo: { extra: { userId: 123 } } })
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.resolveCoachByUserId).not.toHaveBeenCalled();
  });

  it("passes a valid userId and minRole through to resolveCoachByUserId", async () => {
    const { coach, userId } = await resolveMcpActor(
      { authInfo: { extra: { userId: "user_kurt" } } },
      "ADMIN"
    );
    expect(userId).toBe("user_kurt");
    expect(coach.id).toBe("coach-kurt");
    expect(mocks.resolveCoachByUserId).toHaveBeenCalledWith("user_kurt", "ADMIN");
  });

  it("resolveMcpCoach returns just the coach for the same input", async () => {
    const coach = await resolveMcpCoach({ authInfo: { extra: { userId: "user_kurt" } } });
    expect(coach.id).toBe("coach-kurt");
  });
});

describe("errorResult", () => {
  it("surfaces a curated AuthzError message", () => {
    const r = errorResult(new AuthzError(403, "Requires ADMIN access.", "forbidden"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Requires ADMIN access.");
  });

  it("hides raw internal errors behind a generic message (no schema/SQL leak)", () => {
    const r = errorResult(new Error('duplicate key value violates unique constraint "clients_coachId_email_key"'));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Error: Something went wrong.");
    expect(r.content[0].text).not.toContain("constraint");
  });
});
