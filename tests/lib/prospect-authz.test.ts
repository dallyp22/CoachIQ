import { describe, it, expect } from "vitest";
import { prospectWhere, canAccessProspect } from "@/lib/authz";

/**
 * The two-column visibility rule. Both single-column alternatives were tried
 * on paper and both hide prospects someone needs to see — these tests pin the
 * OR so a future "simplification" back to one column fails loudly.
 */

const TODD = "coach-todd";
const KURT = "coach-kurt";

describe("prospectWhere", () => {
  it("matches EITHER ownership or assignment for a COACH", () => {
    expect(prospectWhere(KURT)).toEqual({
      OR: [{ coachId: KURT }, { assignedCoachId: KURT }],
    });
  });

  it("returns an unfiltered fragment for OWNER/ADMIN", () => {
    // scopeCoachId() hands null for a practice-wide view.
    expect(prospectWhere(null)).toEqual({});
  });

  it("does not collapse to ownership alone", () => {
    // The regression: Todd triages the inbox, creates a lead, assigns it to
    // Kurt. coachId=Todd, assignedCoachId=Kurt. Filtering on coachId alone
    // gives Kurt an empty pipeline while Todd sees "Assigned: Kurt" and
    // assumes it is handled.
    const where = prospectWhere(KURT);
    expect(where.OR).toContainEqual({ assignedCoachId: KURT });
  });

  it("does not collapse to assignment alone", () => {
    // The mirror regression: assignedCoachId is nullable, so filtering on it
    // alone makes every unassigned prospect invisible to every COACH —
    // deleting the "nobody has picked this up" state the module exists for.
    const where = prospectWhere(KURT);
    expect(where.OR).toContainEqual({ coachId: KURT });
  });
});

describe("canAccessProspect", () => {
  const owned = { coachId: KURT, assignedCoachId: null };
  const assigned = { coachId: TODD, assignedCoachId: KURT };
  const someoneElses = { coachId: TODD, assignedCoachId: null };

  it("admits a prospect the coach owns", () => {
    expect(canAccessProspect(KURT, owned)).toBe(true);
  });

  it("admits a prospect assigned to the coach but owned by another", () => {
    expect(canAccessProspect(KURT, assigned)).toBe(true);
  });

  it("refuses a prospect that is neither owned nor assigned", () => {
    expect(canAccessProspect(KURT, someoneElses)).toBe(false);
  });

  it("admits everything for a practice-wide caller", () => {
    expect(canAccessProspect(null, someoneElses)).toBe(true);
  });

  it("refuses a missing row rather than defaulting open", () => {
    // A findUnique miss must not read as "no owner, therefore allowed".
    expect(canAccessProspect(KURT, null)).toBe(false);
    expect(canAccessProspect(KURT, undefined)).toBe(false);
  });

  it("still admits a missing row for a practice-wide caller, so the route 404s on its own terms", () => {
    // null coachId short-circuits before the row check; the route's own
    // "not found" path handles the miss and answers 404.
    expect(canAccessProspect(null, null)).toBe(true);
  });

  it("agrees with prospectWhere on the same rows", () => {
    // The two must not drift: a row the list query returns must be a row the
    // single-row check admits, or a coach sees a prospect they cannot open.
    const rows = [owned, assigned, someoneElses];
    const where = prospectWhere(KURT);
    const matchedByWhere = rows.filter((r) =>
      where.OR!.some((clause) =>
        "coachId" in clause ? r.coachId === clause.coachId : r.assignedCoachId === clause.assignedCoachId
      )
    );
    const matchedByCanAccess = rows.filter((r) => canAccessProspect(KURT, r));
    expect(matchedByWhere).toEqual(matchedByCanAccess);
    expect(matchedByWhere).toHaveLength(2);
  });
});
