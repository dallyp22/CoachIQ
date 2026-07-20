import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    requireCoach: vi.fn(),
    clientCreate: vi.fn(),
    coachFindUnique: vi.fn(),
    settingsFindFirst: vi.fn(),
    FakeKnownRequestError,
  };
});

const FakeKnownRequestError = mocks.FakeKnownRequestError;

vi.mock("@/generated/prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: mocks.FakeKnownRequestError },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    client: { create: mocks.clientCreate },
    coach: { findUnique: mocks.coachFindUnique },
    coachSettings: { findFirst: mocks.settingsFindFirst },
  },
}));
vi.mock("@/lib/authz", () => ({
  requireCoach: mocks.requireCoach,
  authzResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 401 }),
}));

import { POST } from "@/app/api/clients/route";

const KURT = { id: "coach-kurt", role: "COACH" as const };
const TODD = { id: "coach-todd", role: "OWNER" as const };

function req(body: unknown) {
  return new Request("http://localhost/api/clients", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCoach.mockResolvedValue(KURT);
  mocks.coachFindUnique.mockResolvedValue({ id: "coach-kurt", defaultHourlyRate: 250 });
  mocks.settingsFindFirst.mockResolvedValue({ defaultHourlyRate: 300 });
  mocks.clientCreate.mockImplementation(async ({ data }: never) => ({
    id: "client-new",
    name: (data as { name: string }).name,
    email: (data as { email: string }).email,
  }));
});

describe("POST /api/clients — coach scoping", () => {
  it("files the client under the signed-in coach", async () => {
    const res = await POST(req({ name: "Alice", email: "Alice@Example.com " }));
    expect(res.status).toBe(201);
    const data = mocks.clientCreate.mock.calls[0][0].data;
    expect(data.coachId).toBe("coach-kurt");
    expect(data.email).toBe("alice@example.com");
  });

  it("ignores a coachId in the body from a COACH — the body must never widen scope", async () => {
    await POST(req({ name: "Alice", email: "a@example.com", coachId: "coach-todd" }));
    expect(mocks.clientCreate.mock.calls[0][0].data.coachId).toBe("coach-kurt");
    // A COACH never triggers the on-behalf-of lookup.
    expect(mocks.coachFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "coach-kurt" } })
    );
  });

  it("lets an OWNER add on another coach's behalf", async () => {
    mocks.requireCoach.mockResolvedValue(TODD);
    mocks.coachFindUnique
      .mockResolvedValueOnce({ id: "coach-kurt" })
      .mockResolvedValueOnce({ id: "coach-kurt", defaultHourlyRate: 250 });

    await POST(req({ name: "Alice", email: "a@example.com", coachId: "coach-kurt" }));
    expect(mocks.clientCreate.mock.calls[0][0].data.coachId).toBe("coach-kurt");
  });

  it("404s when an OWNER names a coach that does not exist", async () => {
    mocks.requireCoach.mockResolvedValue(TODD);
    mocks.coachFindUnique.mockResolvedValueOnce(null);
    const res = await POST(req({ name: "A", email: "a@example.com", coachId: "ghost" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/clients — rate precedence", () => {
  it("uses an explicit rate when supplied", async () => {
    await POST(req({ name: "A", email: "a@example.com", hourlyRate: 500 }));
    expect(mocks.clientCreate.mock.calls[0][0].data.hourlyRate).toBe("500");
  });

  it("falls back to the owning coach's default", async () => {
    await POST(req({ name: "A", email: "a@example.com" }));
    expect(mocks.clientCreate.mock.calls[0][0].data.hourlyRate).toBe(250);
  });

  it("falls back to the practice default when the coach has none", async () => {
    mocks.coachFindUnique.mockResolvedValue({ id: "coach-kurt", defaultHourlyRate: null });
    await POST(req({ name: "A", email: "a@example.com" }));
    expect(mocks.clientCreate.mock.calls[0][0].data.hourlyRate).toBe(300);
  });

  it("omits the rate entirely when nothing is configured, letting the column default stand", async () => {
    mocks.coachFindUnique.mockResolvedValue({ id: "coach-kurt", defaultHourlyRate: null });
    mocks.settingsFindFirst.mockResolvedValue(null);
    await POST(req({ name: "A", email: "a@example.com" }));
    expect("hourlyRate" in mocks.clientCreate.mock.calls[0][0].data).toBe(false);
  });
});

describe("POST /api/clients — validation and duplicates", () => {
  it("rejects a missing name or malformed email", async () => {
    const res = await POST(req({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect((await res.json()).failed[0].error).toMatch(/name and a valid email/);
  });

  it("reports a duplicate within the same coach's book in plain language", async () => {
    mocks.clientCreate.mockRejectedValue(new FakeKnownRequestError("P2002"));
    const res = await POST(req({ name: "A", email: "dupe@example.com" }));
    expect(res.status).toBe(400);
    expect((await res.json()).failed[0].error).toMatch(/already has a client with that email/);
  });
});

describe("POST /api/clients — batch (roster onboarding)", () => {
  it("creates every valid row", async () => {
    const res = await POST(
      req({ clients: [
        { name: "A", email: "a@example.com" },
        { name: "B", email: "b@example.com" },
      ] })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).created).toHaveLength(2);
  });

  it("returns 207 and both halves on a partial failure, keeping the good rows", async () => {
    // Re-pasting a 30-client roster to fix one typo is miserable; the good
    // rows must land.
    mocks.clientCreate
      .mockResolvedValueOnce({ id: "1", name: "A", email: "a@example.com" })
      .mockRejectedValueOnce(new FakeKnownRequestError("P2002"));

    const res = await POST(
      req({ clients: [
        { name: "A", email: "a@example.com" },
        { name: "B", email: "dupe@example.com" },
      ] })
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.created).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
  });

  it("rejects an empty batch", async () => {
    const res = await POST(req({ clients: [] }));
    expect(res.status).toBe(400);
  });
});
