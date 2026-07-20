import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const mocks = vi.hoisted(() => ({
  coachFindMany: vi.fn(),
  coachFindFirst: vi.fn(),
  decryptOptional: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { coach: { findMany: mocks.coachFindMany, findFirst: mocks.coachFindFirst } },
}));
vi.mock("@/lib/secrets", () => ({ decryptOptional: mocks.decryptOptional }));

import { resolveWebhookCoach, describeFailure } from "@/lib/webhook-coach";

const TODD_SECRET = Buffer.from("todds-secret").toString("base64");
const KURT_SECRET = Buffer.from("kurts-secret").toString("base64");

const HEADERS = { webhookId: "msg_1", timestamp: "1700000000", signature: "" };
const PAYLOAD = Buffer.from(JSON.stringify({ recording_id: "rec_1" }));

function signWith(secret: string) {
  const content = Buffer.concat([
    Buffer.from(`${HEADERS.webhookId}.${HEADERS.timestamp}.`),
    PAYLOAD,
  ]);
  const sig = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(content).digest("base64");
  return { ...HEADERS, signature: `v1,${sig}` };
}

const todd = {
  id: "coach-todd",
  name: "Todd",
  loginEmail: "todd@growwithcocreate.com",
  workEmails: ["todd@growwithcocreate.com"],
  coachingTitleFilter: null,
  driveRootFolderId: "drive-todd",
  fathomWebhookSecret: "enc:todd",
};
const kurt = {
  id: "coach-kurt",
  name: "Kurt",
  loginEmail: "kurt@login.com",
  workEmails: ["kurt@work.com"],
  coachingTitleFilter: "1:1",
  driveRootFolderId: "drive-kurt",
  fathomWebhookSecret: "enc:kurt",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.COACHIQ_FATHOM_WEBHOOK_SECRET;
  mocks.coachFindFirst.mockResolvedValue(todd);
  mocks.coachFindMany.mockResolvedValue([todd, kurt]);
  mocks.decryptOptional.mockImplementation((v: string | null) =>
    v === "enc:todd" ? TODD_SECRET : v === "enc:kurt" ? KURT_SECRET : null
  );
});

describe("resolveWebhookCoach — routing by sender", () => {
  it("routes to the coach whose WORK email recorded it, then verifies with their secret only", async () => {
    const out = await resolveWebhookCoach(PAYLOAD, signWith(KURT_SECRET), "kurt@work.com");
    expect(out).toMatchObject({ ok: true, matchedBy: "sender" });
    if (out.ok) expect(out.coach.id).toBe("coach-kurt");
  });

  it("also routes on the login email", async () => {
    const out = await resolveWebhookCoach(PAYLOAD, signWith(KURT_SECRET), "kurt@login.com");
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.coach.id).toBe("coach-kurt");
  });

  it("matches the sender case-insensitively", async () => {
    const out = await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), "todd@growwithcocreate.com");
    expect(out.ok).toBe(true);
  });

  it("never leaks the encrypted secret to the caller", async () => {
    const out = await resolveWebhookCoach(PAYLOAD, signWith(KURT_SECRET), "kurt@work.com");
    expect(out.ok && "fathomWebhookSecret" in out.coach).toBe(false);
  });

  it("rejects — and names the coach — when the sender matches but the signature does not", async () => {
    // The actionable failure: Kurt's stored secret is stale or was rotated.
    const out = await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), "kurt@work.com");
    expect(out).toMatchObject({ ok: false, reason: "sender_secret_mismatch", coachName: "Kurt" });
    expect(describeFailure(out as never)).toMatch(/Kurt[\s\S]*re-register/);
  });

  it("does not silently fall through to another coach's secret when the sender is known", async () => {
    // Kurt recorded it but the payload is signed with Todd's secret; accepting
    // it as Todd's would file Kurt's session under the wrong coach.
    const out = await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), "kurt@work.com");
    expect(out.ok).toBe(false);
  });
});

describe("resolveWebhookCoach — fallback and failures", () => {
  it("falls back to trying every secret when no coach claims the sender address", async () => {
    const out = await resolveWebhookCoach(PAYLOAD, signWith(KURT_SECRET), "kurt@unregistered.com");
    expect(out).toMatchObject({ ok: true, matchedBy: "fallback" });
    if (out.ok) expect(out.coach.id).toBe("coach-kurt");
  });

  it("falls back when the payload carries no recorded_by at all", async () => {
    const out = await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), null);
    expect(out).toMatchObject({ ok: true, matchedBy: "fallback" });
    if (out.ok) expect(out.coach.id).toBe("coach-todd");
  });

  it("rejects when no secret verifies", async () => {
    const bogus = Buffer.from("nobodys-secret").toString("base64");
    const out = await resolveWebhookCoach(PAYLOAD, signWith(bogus), "stranger@example.com");
    expect(out).toMatchObject({ ok: false, reason: "no_secret_matched" });
    expect(describeFailure(out as never)).toMatch(/did not verify against any coach/);
  });

  it("reports the drop loudly when no coach has a secret configured", async () => {
    mocks.coachFindMany.mockResolvedValue([]);
    const out = await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), "todd@growwithcocreate.com");
    expect(out).toMatchObject({ ok: false, reason: "no_coaches_configured" });
    expect(describeFailure(out as never)).toMatch(/no coach has a webhook secret/);
  });

  it("treats an undecryptable secret as a non-match rather than crashing the request", async () => {
    mocks.decryptOptional.mockImplementation((v: string | null) => {
      if (v === "enc:todd") throw new Error("wrong key");
      return KURT_SECRET;
    });
    // Todd's secret is corrupt; Kurt's still verifies via the fallback path.
    const out = await resolveWebhookCoach(PAYLOAD, signWith(KURT_SECRET), null);
    expect(out).toMatchObject({ ok: true });
  });

  it("excludes deactivated coaches and those with no secret from the candidate query", async () => {
    await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), null);
    expect(mocks.coachFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { not: "INACTIVE" }, fathomWebhookSecret: { not: null } },
      })
    );
  });

  it("falls back to the legacy env secret when no coach has one yet", async () => {
    // The window between deploying and running the backfill script. Without
    // this, every recording 401s and Fathom eventually stops retrying —
    // those sessions are unrecoverable.
    mocks.coachFindMany.mockResolvedValue([]);
    process.env.COACHIQ_FATHOM_WEBHOOK_SECRET = TODD_SECRET;

    const out = await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), "todd@growwithcocreate.com");
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.coach.id).toBe("coach-todd");
  });

  it("falls back to the env secret when coaches have secrets but none match and the sender is unclaimed", async () => {
    // Partially-backfilled state: some coach rows carry secrets, but the
    // recording came from an address none of them claim and was signed with
    // the still-live env secret.
    process.env.COACHIQ_FATHOM_WEBHOOK_SECRET = "cGxhaW4tZW52LXNlY3JldA==";
    const out = await resolveWebhookCoach(
      PAYLOAD,
      signWith("cGxhaW4tZW52LXNlY3JldA=="),
      "someone@unclaimed.com"
    );
    expect(out).toMatchObject({ ok: true });
  });

  it("does NOT use the env fallback when the sender is known but their secret fails", async () => {
    // The named-failure path must stay named: silently accepting via the env
    // secret would hide a coach whose stored secret is stale, which is the
    // one thing describeFailure exists to make visible.
    process.env.COACHIQ_FATHOM_WEBHOOK_SECRET = "cGxhaW4tZW52LXNlY3JldA==";
    const out = await resolveWebhookCoach(
      PAYLOAD,
      signWith("cGxhaW4tZW52LXNlY3JldA=="),
      "kurt@work.com"
    );
    expect(out).toMatchObject({ ok: false, reason: "sender_secret_mismatch", coachName: "Kurt" });
  });

  it("announces every use of the legacy fallback so it cannot become permanent silently", async () => {
    mocks.coachFindMany.mockResolvedValue([]);
    process.env.COACHIQ_FATHOM_WEBHOOK_SECRET = TODD_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveWebhookCoach(PAYLOAD, signWith(TODD_SECRET), null);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/backfill-fathom-secret/);
  });

  it("still rejects a bad signature when the env fallback is present", async () => {
    mocks.coachFindMany.mockResolvedValue([]);
    process.env.COACHIQ_FATHOM_WEBHOOK_SECRET = TODD_SECRET;
    const bogus = Buffer.from("not-the-secret").toString("base64");
    const out = await resolveWebhookCoach(PAYLOAD, signWith(bogus), null);
    expect(out).toMatchObject({ ok: false });
  });

  it("admits an INVITED coach — ingest is gated on configuration, not on login", async () => {
    // The onboarding script records a test meeting minutes after Add Coach,
    // before the coach has ever signed in. Excluding non-ACTIVE coaches would
    // make that test fail by design and drop their real sessions too.
    const invited = { ...kurt, status: "INVITED" };
    mocks.coachFindMany.mockResolvedValue([invited]);

    const out = await resolveWebhookCoach(PAYLOAD, signWith(KURT_SECRET), "kurt@work.com");
    expect(out).toMatchObject({ ok: true });

    // The filter excludes only INACTIVE — it must not require ACTIVE.
    const { status } = mocks.coachFindMany.mock.calls[0][0].where;
    expect(status).toEqual({ not: "INACTIVE" });
  });
});
