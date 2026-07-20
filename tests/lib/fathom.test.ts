import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  registerWebhook,
  deleteWebhook,
  verifySignature,
  readSignatureHeaders,
  isTimestampFresh,
  recorderEmail,
  TRIGGERED_FOR,
  FathomApiError,
} from "@/lib/fathom";

const SECRET_RAW = Buffer.from("super-secret-key-material").toString("base64");
const SECRET = `whsec_${SECRET_RAW}`;

function sign(payload: Buffer, webhookId: string, timestamp: string, secret = SECRET_RAW) {
  const content = Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), payload]);
  return crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(content).digest("base64");
}

describe("verifySignature", () => {
  const payload = Buffer.from(JSON.stringify({ recording_id: "abc" }));
  const headers = { webhookId: "msg_1", timestamp: "1700000000", signature: "" };

  it("accepts a correctly signed payload", () => {
    const sig = sign(payload, headers.webhookId, headers.timestamp);
    expect(verifySignature(payload, { ...headers, signature: `v1,${sig}` }, SECRET)).toBe(true);
  });

  it("accepts a secret supplied without the whsec_ prefix", () => {
    const sig = sign(payload, headers.webhookId, headers.timestamp);
    expect(verifySignature(payload, { ...headers, signature: sig }, SECRET_RAW)).toBe(true);
  });

  it("accepts when one of several space-separated signatures matches", () => {
    const sig = sign(payload, headers.webhookId, headers.timestamp);
    const multi = `v1,ZmFrZXNpZ25hdHVyZQ== v1,${sig}`;
    expect(verifySignature(payload, { ...headers, signature: multi }, SECRET)).toBe(true);
  });

  it("rejects a payload signed with a different secret (the coach-routing case)", () => {
    const otherSecret = Buffer.from("a-different-coachs-secret").toString("base64");
    const sig = sign(payload, headers.webhookId, headers.timestamp, otherSecret);
    expect(verifySignature(payload, { ...headers, signature: `v1,${sig}` }, SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = sign(payload, headers.webhookId, headers.timestamp);
    const tampered = Buffer.from(JSON.stringify({ recording_id: "abc", injected: true }));
    expect(verifySignature(tampered, { ...headers, signature: `v1,${sig}` }, SECRET)).toBe(false);
  });

  it("rejects a replayed signature bound to a different webhook id", () => {
    const sig = sign(payload, headers.webhookId, headers.timestamp);
    expect(
      verifySignature(payload, { ...headers, webhookId: "msg_2", signature: `v1,${sig}` }, SECRET)
    ).toBe(false);
  });

  it("returns false — never throws — on a wrong-length signature", () => {
    // timingSafeEqual throws when buffer lengths differ; a malformed header
    // must be a rejected request, not a 500.
    expect(() =>
      verifySignature(payload, { ...headers, signature: "v1,short" }, SECRET)
    ).not.toThrow();
    expect(verifySignature(payload, { ...headers, signature: "v1,short" }, SECRET)).toBe(false);
  });

  it("rejects an empty or unusable secret instead of accepting anything", () => {
    const sig = sign(payload, headers.webhookId, headers.timestamp);
    expect(verifySignature(payload, { ...headers, signature: sig }, "")).toBe(false);
    expect(verifySignature(payload, { ...headers, signature: sig }, "whsec_")).toBe(false);
  });
});

describe("readSignatureHeaders", () => {
  it("reads the three Standard Webhooks headers", () => {
    const h = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,sig",
    });
    expect(readSignatureHeaders(h)).toEqual({
      webhookId: "msg_1",
      timestamp: "1700000000",
      signature: "v1,sig",
    });
  });

  it("returns null when any header is missing", () => {
    const h = new Headers({ "webhook-id": "msg_1", "webhook-timestamp": "1700000000" });
    expect(readSignatureHeaders(h)).toBeNull();
  });
});

describe("isTimestampFresh", () => {
  const now = 1_700_000_000_000;
  it("accepts a timestamp inside the replay window", () => {
    expect(isTimestampFresh("1700000000", now)).toBe(true);
    expect(isTimestampFresh(String(1_700_000_000 - 299), now)).toBe(true);
  });
  it("rejects a stale timestamp", () => {
    expect(isTimestampFresh(String(1_700_000_000 - 3600), now)).toBe(false);
  });
  it("rejects a timestamp far in the future", () => {
    expect(isTimestampFresh(String(1_700_000_000 + 3600), now)).toBe(false);
  });
  it("rejects a non-numeric timestamp", () => {
    expect(isTimestampFresh("not-a-number", now)).toBe(false);
  });
});

describe("recorderEmail", () => {
  it("extracts and normalizes the recorder address", () => {
    expect(recorderEmail({ recorded_by: { email: "  Kurt@Example.COM " } })).toBe("kurt@example.com");
  });
  it("returns null when recorded_by is absent or malformed", () => {
    expect(recorderEmail({})).toBeNull();
    expect(recorderEmail({ recorded_by: {} })).toBeNull();
    expect(recorderEmail({ recorded_by: { email: "not-an-email" } })).toBeNull();
  });
});

describe("registerWebhook", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pins triggered_for to my_recordings so team-shared meetings cannot double-ingest", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "wh_1", url: "https://app/api/webhook/fathom", secret: "whsec_x" }),
    });

    const result = await registerWebhook("key_123", "https://app/api/webhook/fathom");

    expect(result).toEqual({
      id: "wh_1",
      url: "https://app/api/webhook/fathom",
      secret: "whsec_x",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.fathom.ai/external/v1/webhooks");
    expect(init.headers["X-Api-Key"]).toBe("key_123");
    const body = JSON.parse(init.body);
    expect(body.triggered_for).toEqual(["my_recordings"]);
    expect(TRIGGERED_FOR).toEqual(["my_recordings"]);
    expect(body.destination_url).toBe("https://app/api/webhook/fathom");
    expect(body.include_transcript).toBe(true);
    expect(init.signal).toBeDefined();
  });

  it("reports a rejected API key in words the Add Coach form can show", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" });
    await expect(registerWebhook("bad", "https://app/hook")).rejects.toThrow(/rejected the API key/);
  });

  it("surfaces other API failures with the status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" });
    await expect(registerWebhook("k", "https://app/hook")).rejects.toMatchObject({
      name: "FathomApiError",
      status: 429,
    });
  });

  it("treats a network failure or timeout as a reachability error, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    await expect(registerWebhook("k", "https://app/hook")).rejects.toThrow(/Could not reach the Fathom API/);
  });

  it("fails loudly if Fathom returns a webhook with no secret", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "wh_1" }) });
    await expect(registerWebhook("k", "https://app/hook")).rejects.toThrow(/no id or secret/);
  });
});

describe("deleteWebhook", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("deletes by id, url-encoded", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await deleteWebhook("key", "wh/1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.fathom.ai/external/v1/webhooks/wh%2F1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("raises a FathomApiError on failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    await expect(deleteWebhook("key", "wh_1")).rejects.toBeInstanceOf(FathomApiError);
  });
});
