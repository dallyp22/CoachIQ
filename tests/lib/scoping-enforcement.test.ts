import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guarantee, not a behaviour test.
 *
 * Coach isolation only holds if EVERY surface that reads coach-owned data
 * resolves a coach first. A new route or page that queries Prisma directly
 * and forgets to scope is invisible in review and silently leaks another
 * coach's clients — so this test fails the build instead.
 *
 * When you add a genuinely practice-wide or unauthenticated surface, add it
 * to the allowlist below WITH a reason. That makes the exception a decision
 * someone made, rather than an omission nobody noticed.
 */

const ROOT = join(__dirname, "..", "..", "src", "app");

/** Models whose rows belong to a coach (directly or through a client). */
const OWNED_MODELS = [
  "prisma.client.",
  "prisma.session.",
  "prisma.transcript.",
  "prisma.timeEntry.",
  "prisma.invoice.",
  "prisma.prepBrief.",
  "prisma.billingGroup.",
  "prisma.pendingRecording.",
];

/** Surfaces that legitimately do not resolve a coach. */
const ALLOWLIST: Record<string, string> = {
  "api/webhook/fathom/route.ts": "public; authenticated by per-coach HMAC and resolves its own coach from the payload",
  "api/webhook/stripe/route.ts": "public; authenticated by Stripe signature, acts on one invoice by id",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((full) => ({
  rel: full.slice(ROOT.length + 1).split("\\").join("/"),
  source: readFileSync(full, "utf8"),
}));

const touchesOwnedData = (source: string) => OWNED_MODELS.some((m) => source.includes(m));
const resolvesCoach = (source: string) => source.includes("requireCoach");

describe("coach scoping enforcement", () => {
  it("finds the app directory (guards against a silently empty scan)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => touchesOwnedData(f.source))).toBe(true);
  });

  it("every surface reading coach-owned data resolves a coach", () => {
    const offenders = files
      .filter((f) => touchesOwnedData(f.source))
      .filter((f) => !ALLOWLIST[f.rel])
      .filter((f) => !resolvesCoach(f.source))
      .map((f) => f.rel);

    expect(
      offenders,
      `These read coach-owned models without resolving a coach:\n  ${offenders.join("\n  ")}\n` +
        `Either call requireCoach()/requireCoachPage() and scope the query, or add the file to ALLOWLIST with a reason.`
    ).toEqual([]);
  });

  it("keeps the allowlist honest — every entry still exists and still needs the exemption", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `Allowlisted file no longer exists: ${rel} — remove it from ALLOWLIST`).toBeDefined();
      expect(
        touchesOwnedData(file!.source),
        `${rel} no longer reads coach-owned data — remove it from ALLOWLIST`
      ).toBe(true);
    }
  });

  it("dashboard pages use the redirecting page helper, not the API-flavoured one", () => {
    const wrong = files
      .filter((f) => f.rel.startsWith("(dashboard)/") && touchesOwnedData(f.source))
      .filter((f) => !f.source.includes("requireCoachPage"))
      .map((f) => f.rel);

    expect(
      wrong,
      `Server components must use requireCoachPage (which redirects) rather than requireCoach:\n  ${wrong.join("\n  ")}`
    ).toEqual([]);
  });
});
