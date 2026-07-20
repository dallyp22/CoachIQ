import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  coachFindUnique: vi.fn(),
  coachUpdate: vi.fn(),
  createInvitation: vi.fn(),
  registerWebhook: vi.fn(),
  encryptOptional: vi.fn((v: string | null) => (v ? `enc:${v}` : null)),
  decryptOptional: vi.fn((v: string | null) => (v ? String(v).replace(/^enc:/, "") : null)),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({ invitations: { createInvitation: mocks.createInvitation } }),
}));
vi.mock("@/lib/db", () => ({
  prisma: { coach: { findUnique: mocks.coachFindUnique, update: mocks.coachUpdate } },
}));
vi.mock("@/lib/secrets", () => ({
  encryptOptional: mocks.encryptOptional,
  decryptOptional: mocks.decryptOptional,
}));
vi.mock("@/lib/fathom", () => ({ registerWebhook: mocks.registerWebhook }));

import { provisionCoach, outstandingActions } from "@/lib/coach-onboarding";

const BASE = {
  id: "coach-kurt",
  loginEmail: "kurt@example.com",
  clerkUserId: null,
  inviteStatus: "PENDING",
  fathomApiKey: "enc:fathom-key",
  fathomWebhookId: null,
  fathomStatus: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.coachFindUnique.mockResolvedValue({ ...BASE });
  mocks.coachUpdate.mockResolvedValue({});
  mocks.createInvitation.mockResolvedValue({ id: "inv_1" });
  mocks.registerWebhook.mockResolvedValue({ id: "wh_1", url: "u", secret: "whsec_abc" });
});

describe("provisionCoach — happy path", () => {
  it("invites with the coachId in public metadata and registers the webhook", async () => {
    const result = await provisionCoach("coach-kurt");

    expect(result).toMatchObject({ inviteStatus: "OK", fathomStatus: "OK" });
    expect(mocks.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: "kurt@example.com",
        publicMetadata: { coachId: "coach-kurt" },
        ignoreExisting: true,
      })
    );
    // The returned secret is stored encrypted, never in the clear.
    expect(mocks.coachUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fathomWebhookId: "wh_1",
          fathomWebhookSecret: "enc:whsec_abc",
        }),
      })
    );
  });

  it("uses the decrypted API key to register", async () => {
    await provisionCoach("coach-kurt");
    expect(mocks.registerWebhook).toHaveBeenCalledWith("fathom-key", expect.stringContaining("/api/webhook/fathom"));
  });
});

describe("provisionCoach — idempotency", () => {
  it("does NOT register a second webhook when one already exists", async () => {
    // A second webhook would deliver every meeting twice: two sessions, two
    // billable time entries, two invoice lines.
    mocks.coachFindUnique.mockResolvedValue({ ...BASE, fathomWebhookId: "wh_existing" });

    const result = await provisionCoach("coach-kurt");

    expect(mocks.registerWebhook).not.toHaveBeenCalled();
    expect(result.fathomStatus).toBe("OK");
  });

  it("does not re-invite a coach who has already signed in", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...BASE, clerkUserId: "user_1" });
    const result = await provisionCoach("coach-kurt");
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(result.inviteStatus).toBe("OK");
  });

  it("does not re-invite when the invitation already succeeded", async () => {
    mocks.coachFindUnique.mockResolvedValue({ ...BASE, inviteStatus: "OK" });
    await provisionCoach("coach-kurt");
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });
});

describe("provisionCoach — partial failure isolation", () => {
  it("still registers Fathom when the Clerk invitation fails", async () => {
    mocks.createInvitation.mockRejectedValue(new Error("Clerk is down"));
    const result = await provisionCoach("coach-kurt");
    expect(result.inviteStatus).toBe("FAILED");
    expect(result.inviteError).toMatch(/Clerk is down/);
    expect(result.fathomStatus).toBe("OK");
  });

  it("still invites when Fathom registration fails", async () => {
    mocks.registerWebhook.mockRejectedValue(new Error("Fathom rejected the API key."));
    const result = await provisionCoach("coach-kurt");
    expect(result.inviteStatus).toBe("OK");
    expect(result.fathomStatus).toBe("FAILED");
    expect(result.fathomError).toMatch(/rejected the API key/);
  });

  it("persists both step statuses so the list can show chips and offer Retry", async () => {
    mocks.registerWebhook.mockRejectedValue(new Error("boom"));
    await provisionCoach("coach-kurt");
    expect(mocks.coachUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { inviteStatus: "OK", fathomStatus: "FAILED" } })
    );
  });

  it("leaves Fathom PENDING — not FAILED — when no API key was supplied", async () => {
    // No key is a deliberate choice (manual webhook setup), not an error.
    mocks.coachFindUnique.mockResolvedValue({ ...BASE, fathomApiKey: null });
    const result = await provisionCoach("coach-kurt");
    expect(result.fathomStatus).toBe("PENDING");
    expect(mocks.registerWebhook).not.toHaveBeenCalled();
  });

  it("reports an undecryptable key rather than crashing the request", async () => {
    mocks.decryptOptional.mockImplementation(() => {
      throw new Error("wrong key");
    });
    const result = await provisionCoach("coach-kurt");
    expect(result.fathomStatus).toBe("FAILED");
    expect(result.fathomError).toMatch(/could not be decrypted/);
  });

  it("raises when the coach does not exist", async () => {
    mocks.coachFindUnique.mockResolvedValue(null);
    await expect(provisionCoach("nope")).rejects.toThrow(/not found/);
  });
});

describe("outstandingActions", () => {
  const configured = { googleCalendarId: "cal", driveRootFolderId: "drive" };

  it("is empty when everything provisioned and is configured", () => {
    expect(
      outstandingActions({ inviteStatus: "OK", fathomStatus: "OK" }, configured)
    ).toEqual([]);
  });

  it("tells the operator how to finish a manual Fathom setup, with the destination URL", () => {
    const todo = outstandingActions({ inviteStatus: "OK", fathomStatus: "PENDING" }, configured);
    expect(todo.join(" ")).toMatch(/webhook manually/);
    expect(todo.join(" ")).toMatch(/api\/webhook\/fathom/);
  });

  it("names each missing piece so nothing that used to be a checklist item disappears", () => {
    const todo = outstandingActions(
      { inviteStatus: "FAILED", fathomStatus: "FAILED" },
      { googleCalendarId: null, driveRootFolderId: null }
    );
    expect(todo).toHaveLength(4);
    expect(todo.join(" ")).toMatch(/invitation/);
    expect(todo.join(" ")).toMatch(/calendar/);
    expect(todo.join(" ")).toMatch(/Drive/);
  });
});
