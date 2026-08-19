import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * createClients is shared by /api/clients and the MCP create_client tool. The
 * per-coach duplicate mapping is the security-relevant branch: the same person
 * coached by two coaches is legitimate and must not collide.
 */

const c = vi.hoisted(() => ({ create: vi.fn(), coachFind: vi.fn(), settingsFind: vi.fn() }));

const { FakeP2002 } = vi.hoisted(() => ({
  FakeP2002: class extends Error {
    code = "P2002";
  },
}));

vi.mock("@/generated/prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: FakeP2002 },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coach: { findUnique: c.coachFind },
    coachSettings: { findFirst: c.settingsFind },
    client: { create: c.create },
  },
}));

import { createClients } from "@/lib/clients";

beforeEach(() => {
  vi.clearAllMocks();
  c.coachFind.mockResolvedValue({ defaultHourlyRate: 200 });
  c.settingsFind.mockResolvedValue(null);
});

describe("createClients", () => {
  it("rejects rows missing a name or a valid email without creating them", async () => {
    const r = await createClients("coach-kurt", [
      { name: "", email: "x@y.com" },
      { name: "A", email: "not-an-email" },
    ]);
    expect(r.created).toHaveLength(0);
    expect(r.failed).toHaveLength(2);
    expect(c.create).not.toHaveBeenCalled();
  });

  it("maps a per-coach duplicate (P2002) to the friendly message", async () => {
    c.create.mockRejectedValue(new FakeP2002("dup"));
    const r = await createClients("coach-kurt", [{ name: "Ada", email: "ada@b.com" }]);
    expect(r.created).toHaveLength(0);
    expect(r.failed[0].error).toMatch(/already has a client/);
  });

  it("creates a valid client and lowercases the email", async () => {
    c.create.mockResolvedValue({ id: "cl1", name: "Ada", email: "ada@b.com" });
    const r = await createClients("coach-kurt", [{ name: "Ada", email: "Ada@B.com" }]);
    expect(r.created).toEqual([{ id: "cl1", name: "Ada", email: "ada@b.com" }]);
    expect(c.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "ada@b.com", coachId: "coach-kurt" }) })
    );
  });

  it("passes a generic error straight through when it is not a duplicate", async () => {
    c.create.mockRejectedValue(new Error("connection reset"));
    const r = await createClients("coach-kurt", [{ name: "Ada", email: "ada@b.com" }]);
    expect(r.failed[0].error).toBe("connection reset");
  });
});
