import { describe, it, expect, vi, beforeEach } from "vitest";

// feedback-notify calls prisma.feedbackItem.count — capture the `where` it
// builds so we can assert the role-scoped query shape without a database.
const count = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { feedbackItem: { count: (...a: unknown[]) => count(...a) } } }));

import { feedbackUnreadCount } from "@/lib/feedback-notify";

beforeEach(() => {
  count.mockReset();
  count.mockResolvedValue(0);
});

describe("feedbackUnreadCount", () => {
  it("scopes a coach to their own items and counts activity by others", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    await feedbackUnreadCount({ id: "c1", role: "COACH", feedbackLastSeenAt: since });

    const where = count.mock.calls[0][0].where;
    expect(where.submittedById).toBe("c1");
    // A stage move not made by this coach (includes null/system via Prisma `not`).
    expect(where.OR[0].changes.some.changedById).toEqual({ not: "c1" });
    expect(where.OR[0].changes.some.changedAt).toEqual({ gt: since });
    // Comments by anyone but this coach — team (null author) still counts.
    expect(where.OR[1].comments.some.authorId).toEqual({ not: "c1" });
  });

  it("scopes an owner to all items and excludes their own team replies", async () => {
    await feedbackUnreadCount({ id: "a1", role: "OWNER", feedbackLastSeenAt: null });

    const where = count.mock.calls[0][0].where;
    expect(where.submittedById).toBeUndefined();
    // Team (null-author) comments are excluded for admins — they write those.
    expect(where.OR[1].comments.some.AND).toEqual([{ authorId: { not: null } }, { authorId: { not: "a1" } }]);
  });

  it("treats a never-opened inbox (null lastSeen) as epoch", async () => {
    await feedbackUnreadCount({ id: "c1", role: "COACH", feedbackLastSeenAt: null });

    const where = count.mock.calls[0][0].where;
    expect(where.OR[0].changes.some.changedAt.gt).toEqual(new Date(0));
  });
});
