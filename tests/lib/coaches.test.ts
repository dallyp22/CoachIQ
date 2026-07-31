import { describe, it, expect, vi, beforeEach } from "vitest";

// coachesForFilter feeds the admin CoachFilter. Two invariants matter:
//   - a COACH is pinned to themselves and NEVER queries other coaches (a list
//     with everyone's names would itself leak the practice roster);
//   - OWNER/ADMIN get every coach that isn't deactivated, name-ordered to match
//     how the filter renders them.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { coach: { findMany: mocks.findMany } },
}));

import { coachesForFilter } from "@/lib/coaches";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([
    { id: "coach-kurt", name: "Kurt" },
    { id: "coach-todd", name: "Todd" },
  ]);
});

describe("coachesForFilter", () => {
  it("pins a COACH to only themselves and never touches the DB", async () => {
    const result = await coachesForFilter({ id: "coach-kurt", name: "Kurt", role: "COACH" });
    expect(result).toEqual([{ id: "coach-kurt", name: "Kurt" }]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("gives an OWNER every non-inactive coach, name-ordered", async () => {
    const result = await coachesForFilter({ id: "coach-todd", name: "Todd", role: "OWNER" });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { status: { not: "INACTIVE" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    expect(result).toEqual([
      { id: "coach-kurt", name: "Kurt" },
      { id: "coach-todd", name: "Todd" },
    ]);
  });

  it("treats ADMIN the same as OWNER (whole practice)", async () => {
    await coachesForFilter({ id: "coach-dallas", name: "Dallas", role: "ADMIN" });
    expect(mocks.findMany).toHaveBeenCalledOnce();
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ status: { not: "INACTIVE" } });
  });
});
