import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  coachFindUnique: vi.fn(),
  coachFindFirst: vi.fn(),
  coachUpdate: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  currentUser: mocks.currentUser,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coach: {
      findUnique: mocks.coachFindUnique,
      findFirst: mocks.coachFindFirst,
      update: mocks.coachUpdate,
    },
  },
}));

import {
  requireCoach,
  canAccess,
  scopeCoachId,
  clientWhere,
  viaClientWhere,
  invoiceWhere,
  resolveCoachConfig,
  type ResolvedCoach,
} from "@/lib/authz";

const TODD = {
  id: "coach-todd",
  name: "Todd Zimbelman",
  loginEmail: "todd@growwithcocreate.com",
  workEmails: ["todd@growwithcocreate.com"],
  role: "OWNER" as const,
  status: "ACTIVE" as const,
  coachingTitleFilter: null,
  googleCalendarId: "cal-todd",
  calendarSyncEnabled: true,
  driveRootFolderId: "drive-todd",
  defaultHourlyRate: 300,
};

const KURT = { ...TODD, id: "coach-kurt", name: "Kurt", loginEmail: "kurt@example.com", role: "COACH" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user_123" });
  mocks.coachFindUnique.mockResolvedValue(TODD);
});

describe("requireCoach — authentication and linking", () => {
  it("resolves the coach bound to the Clerk user without calling Clerk's API", async () => {
    const coach = await requireCoach();
    expect(coach.id).toBe("coach-todd");
    // Fast path is one indexed DB read; no Clerk round-trip.
    expect(mocks.currentUser).not.toHaveBeenCalled();
  });

  it("rejects a request with no signed-in user", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    await expect(requireCoach()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("denies a signed-in Clerk user who is not a coach (closes the presence-only hole)", async () => {
    mocks.coachFindUnique.mockResolvedValue(null);
    mocks.currentUser.mockResolvedValue({
      publicMetadata: {},
      emailAddresses: [{ emailAddress: "stranger@nowhere.com" }],
    });
    mocks.coachFindFirst.mockResolvedValue(null);
    await expect(requireCoach()).rejects.toMatchObject({ status: 403, code: "no_coach" });
  });

  it("links on first sign-in using the invitation's coachId, not the email", async () => {
    mocks.coachFindUnique.mockResolvedValue(null);
    mocks.currentUser.mockResolvedValue({
      publicMetadata: { coachId: "coach-kurt" },
      // Signed up with a different address than we invited — the metadata wins.
      emailAddresses: [{ emailAddress: "kurt.personal@gmail.com" }],
    });
    mocks.coachFindFirst.mockResolvedValue({ id: "coach-kurt", clerkUserId: null });
    mocks.coachUpdate.mockResolvedValue(KURT);

    const coach = await requireCoach();
    expect(coach.id).toBe("coach-kurt");
    expect(mocks.coachFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "coach-kurt" } })
    );
    expect(mocks.coachUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "coach-kurt" },
        data: { clerkUserId: "user_123", status: "ACTIVE" },
      })
    );
  });

  it("falls back to email matching when there is no invitation metadata", async () => {
    mocks.coachFindUnique.mockResolvedValue(null);
    mocks.currentUser.mockResolvedValue({
      publicMetadata: {},
      emailAddresses: [{ emailAddress: "Todd@GrowWithCoCreate.com" }],
    });
    mocks.coachFindFirst.mockResolvedValue({ id: "coach-todd", clerkUserId: null });
    mocks.coachUpdate.mockResolvedValue(TODD);

    await requireCoach();
    expect(mocks.coachFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { loginEmail: { in: ["todd@growwithcocreate.com"], mode: "insensitive" } },
      })
    );
  });

  it("refuses to re-point a coach row already bound to a different Clerk account", async () => {
    mocks.coachFindUnique.mockResolvedValue(null);
    mocks.currentUser.mockResolvedValue({
      publicMetadata: { coachId: "coach-kurt" },
      emailAddresses: [{ emailAddress: "impostor@example.com" }],
    });
    mocks.coachFindFirst.mockResolvedValue({ id: "coach-kurt", clerkUserId: "user_someone_else" });

    await expect(requireCoach()).rejects.toMatchObject({ code: "no_coach" });
    expect(mocks.coachUpdate).not.toHaveBeenCalled();
  });

  it("recovers when two first requests race on the unique clerkUserId", async () => {
    mocks.coachFindUnique
      .mockResolvedValueOnce(null) // initial lookup
      .mockResolvedValueOnce(KURT); // re-read after the losing update
    mocks.currentUser.mockResolvedValue({
      publicMetadata: { coachId: "coach-kurt" },
      emailAddresses: [{ emailAddress: "kurt@example.com" }],
    });
    mocks.coachFindFirst.mockResolvedValue({ id: "coach-kurt", clerkUserId: null });
    mocks.coachUpdate.mockRejectedValue(new Error("unique constraint"));

    const coach = await requireCoach();
    expect(coach.id).toBe("coach-kurt");
  });
});

describe("requireCoach — status and role gates", () => {
  it("denies a deactivated coach immediately (no cache to wait out)", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...KURT, status: "INACTIVE" });
    await expect(requireCoach()).rejects.toMatchObject({ status: 403, code: "inactive" });
  });

  it("admits an INVITED coach who has signed in — status gates login, not access", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...KURT, status: "INVITED" });
    await expect(requireCoach()).resolves.toMatchObject({ id: "coach-kurt" });
  });

  it("enforces the role floor: COACH cannot reach an ADMIN surface", async () => {
    mocks.coachFindUnique.mockResolvedValue(KURT);
    await expect(requireCoach("ADMIN")).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("admits OWNER to an ADMIN surface (OWNER outranks ADMIN)", async () => {
    await expect(requireCoach("ADMIN")).resolves.toMatchObject({ role: "OWNER" });
  });

  it("admits ADMIN to an ADMIN surface but not an OWNER surface", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...TODD, role: "ADMIN" });
    await expect(requireCoach("ADMIN")).resolves.toMatchObject({ role: "ADMIN" });
    await expect(requireCoach("OWNER")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("does not leak the status field to callers", async () => {
    const coach = await requireCoach();
    expect(coach).not.toHaveProperty("status");
  });
});

describe("scopeCoachId", () => {
  const coachRow = { ...KURT } as unknown as ResolvedCoach;
  const ownerRow = { ...TODD } as unknown as ResolvedCoach;

  it("pins a COACH to their own id and ignores a requested override", async () => {
    expect(scopeCoachId(coachRow, "coach-todd")).toBe("coach-kurt");
    expect(scopeCoachId(coachRow, null)).toBe("coach-kurt");
  });

  it("gives OWNER/ADMIN the whole practice by default", () => {
    expect(scopeCoachId(ownerRow, null)).toBeNull();
    expect(scopeCoachId(ownerRow, "")).toBeNull();
  });

  it("lets OWNER/ADMIN narrow to one coach", () => {
    expect(scopeCoachId(ownerRow, "coach-kurt")).toBe("coach-kurt");
  });
});

describe("where-fragment builders", () => {
  it("filters clients by coach, or not at all for practice-wide reads", () => {
    expect(clientWhere("c1")).toEqual({ coachId: "c1" });
    expect(clientWhere(null)).toEqual({});
  });

  it("reaches the coach through the client relation", () => {
    expect(viaClientWhere("c1")).toEqual({ client: { coachId: "c1" } });
    expect(viaClientWhere(null)).toEqual({});
  });

  it("covers BOTH invoice paths so group invoices are not silently dropped", () => {
    // An invoice has clientId XOR groupId. Filtering on client alone would
    // make every group invoice invisible to its own coach.
    expect(invoiceWhere("c1")).toEqual({
      OR: [{ client: { coachId: "c1" } }, { group: { coachId: "c1" } }],
    });
    expect(invoiceWhere(null)).toEqual({});
  });
});

describe("canAccess", () => {
  it("lets a practice-wide caller reach any row", () => {
    expect(canAccess(null, "coach-kurt")).toBe(true);
    expect(canAccess(null, null)).toBe(true);
  });

  it("lets a scoped caller reach only their own rows", () => {
    expect(canAccess("coach-kurt", "coach-kurt")).toBe(true);
    expect(canAccess("coach-kurt", "coach-todd")).toBe(false);
    expect(canAccess("coach-kurt", null)).toBe(false);
    expect(canAccess("coach-kurt", undefined)).toBe(false);
  });
});

describe("resolveCoachConfig", () => {
  const practice = {
    coachingTitleFilter: "coaching|session",
    timezone: "America/Chicago",
    defaultHourlyRate: 300,
  };
  const base = {
    coachingTitleFilter: null,
    googleCalendarId: "cal-1",
    calendarSyncEnabled: true,
    defaultHourlyRate: null,
    loginEmail: "kurt@example.com",
    workEmails: ["kurt@work.com"],
  };

  it("falls back to the practice filter when the coach has none", () => {
    expect(resolveCoachConfig(base, practice).coachingTitleFilter).toBe("coaching|session");
  });

  it("prefers the coach's own filter", () => {
    expect(
      resolveCoachConfig({ ...base, coachingTitleFilter: "1:1" }, practice).coachingTitleFilter
    ).toBe("1:1");
  });

  it("treats a blank filter as absent — an empty regex would match everything", () => {
    expect(
      resolveCoachConfig({ ...base, coachingTitleFilter: "   " }, practice).coachingTitleFilter
    ).toBe("coaching|session");
  });

  it("never falls through on calendarSyncEnabled: false is a real setting", () => {
    expect(resolveCoachConfig({ ...base, calendarSyncEnabled: false }, practice).calendarSyncEnabled).toBe(false);
  });

  it("collects login and work emails, lowercased and deduped, for attendee exclusion", () => {
    const cfg = resolveCoachConfig(
      { ...base, loginEmail: "Kurt@Example.com", workEmails: ["KURT@example.com", "kurt@work.com", ""] },
      practice
    );
    expect(cfg.coachEmails.sort()).toEqual(["kurt@example.com", "kurt@work.com"]);
  });

  it("falls back to the practice rate, then to null, without inventing a number", () => {
    expect(resolveCoachConfig(base, practice).defaultHourlyRate).toBe(300);
    expect(resolveCoachConfig({ ...base, defaultHourlyRate: 250 }, practice).defaultHourlyRate).toBe(250);
    expect(resolveCoachConfig(base, null).defaultHourlyRate).toBeNull();
  });

  it("survives a missing practice settings row", () => {
    const cfg = resolveCoachConfig(base, null);
    expect(cfg.coachingTitleFilter).toBeNull();
    expect(cfg.timezone).toBe("America/Chicago");
  });
});
