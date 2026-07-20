import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guarantee: every authenticated surface resolves a coach.
 *
 * This test was originally written the other way round — detect a surface
 * that touches coach-owned data, then require it to call requireCoach. That
 * detection grepped for `prisma.<model>.` in the route file itself, so any
 * route reaching data through a src/lib helper was invisible to it. Two
 * unscoped routes (invoices/generate, calendar/sync) passed it for exactly
 * that reason, and a third (calendar/test) slipped through because it reads
 * coachSettings, which was not in the model list.
 *
 * The invariant is now inverted and does not depend on detecting data access
 * at all: EVERY route handler and page under src/app must resolve a coach,
 * unless it appears in PUBLIC with a reason. Indirection cannot defeat it,
 * because it never asks what the file touches — only whether it authenticates.
 */

const ROOT = join(__dirname, "..", "..", "src", "app");

/**
 * Surfaces that legitimately do not resolve a coach. Every entry needs a
 * reason, and the tests below fail if an entry stops existing or silently
 * starts resolving a coach after all.
 */
const PUBLIC: Record<string, string> = {
  "api/webhook/fathom/route.ts":
    "public; authenticated by per-coach HMAC and resolves its own coach from the payload",
  "api/webhook/stripe/route.ts":
    "public; authenticated by Stripe signature, acts on one invoice by id",
  "api/cron/workday-sync/route.ts": "cron; CRON_SECRET auth, practice-wide by design",
  "api/cron/invoice-generation/route.ts": "cron; CRON_SECRET auth, practice-wide by design",
  "api/cron/start-of-day/route.ts": "cron; CRON_SECRET auth, currently unscheduled",
  "sign-in/[[...sign-in]]/page.tsx": "the sign-in page itself",
  "no-access/page.tsx": "shown precisely when coach resolution fails",
  "layout.tsx": "root layout, renders no coach-owned data",
  // Client-component pages hold no server data — everything they render comes
  // from coach-scoped APIs. The dashboard layout gates them so a signed-in
  // stranger lands on /no-access rather than a shell of failing requests.
  "(dashboard)/analytics/page.tsx": "client component; data comes from coach-scoped APIs, gated by the dashboard layout",
  "(dashboard)/search/page.tsx": "client component; data comes from coach-scoped APIs, gated by the dashboard layout",
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

/** A surface a signed-in user can reach: a route handler or a rendered page. */
const isSurface = (f: { rel: string; source: string }) =>
  /(^|\/)route\.ts$/.test(f.rel) ||
  (/(^|\/)page\.tsx$/.test(f.rel) && f.source.includes("export default"));

const resolvesCoach = (source: string) =>
  /requireCoach\s*\(|requireCoachPage\s*\(/.test(source);

describe("coach scoping enforcement", () => {
  it("scans a plausible number of surfaces (guards against an empty walk)", () => {
    const surfaces = files.filter(isSurface);
    expect(surfaces.length).toBeGreaterThan(20);
  });

  it("every authenticated surface resolves a coach", () => {
    const offenders = files
      .filter(isSurface)
      .filter((f) => !PUBLIC[f.rel])
      .filter((f) => !resolvesCoach(f.source))
      .map((f) => f.rel);

    expect(
      offenders,
      `These surfaces never resolve a coach:\n  ${offenders.join("\n  ")}\n` +
        `Call requireCoach() (routes) or requireCoachPage() (pages) and scope the query, ` +
        `or add the file to PUBLIC with a reason. Reaching data through a src/lib helper ` +
        `does not exempt a surface — that is how invoices/generate and calendar/sync were missed.`
    ).toEqual([]);
  });

  it("keeps PUBLIC honest — every entry exists and still needs the exemption", () => {
    for (const rel of Object.keys(PUBLIC)) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `PUBLIC lists a file that no longer exists: ${rel}`).toBeDefined();
      expect(
        resolvesCoach(file!.source),
        `${rel} now resolves a coach — remove it from PUBLIC`
      ).toBe(false);
    }
  });

  it("the dashboard layout gate exists — two PUBLIC exemptions depend on it", () => {
    // Those exemptions say "gated by the dashboard layout". Without this
    // assertion, deleting that call leaves every test green while the stated
    // reason silently becomes false.
    const layout = files.find((f) => f.rel === "(dashboard)/layout.tsx");
    expect(layout, "(dashboard)/layout.tsx is missing").toBeDefined();
    expect(
      layout!.source.includes("requireCoachPage"),
      "The dashboard layout no longer resolves a coach, but PUBLIC exemptions still claim it does"
    ).toBe(true);
  });

  it("dashboard pages use the redirecting helper, not the API-flavoured one", () => {
    const wrong = files
      .filter((f) => f.rel.startsWith("(dashboard)/") && isSurface(f) && !PUBLIC[f.rel])
      .filter((f) => !f.source.includes("requireCoachPage"))
      .map((f) => f.rel);

    expect(
      wrong,
      `Server components must use requireCoachPage (which redirects) rather than requireCoach:\n  ${wrong.join("\n  ")}`
    ).toEqual([]);
  });

  it("no surface reaches a practice-wide billing or sync helper without an ADMIN floor", () => {
    // These helpers act across the whole practice regardless of caller, so a
    // plain requireCoach() is not enough — a COACH must not trigger them.
    const PRACTICE_WIDE = [
      "@/lib/billing/generate",
      "@/lib/calendar-sync",
      "@/lib/deliver-briefs",
    ];
    const offenders = files
      .filter(isSurface)
      .filter((f) => !PUBLIC[f.rel])
      .filter((f) => PRACTICE_WIDE.some((h) => f.source.includes(h)))
      .filter((f) => !/requireCoach\s*\(\s*["']ADMIN["']|requireCoach\s*\(\s*["']OWNER["']/.test(f.source))
      .map((f) => f.rel);

    expect(
      offenders,
      `These call a practice-wide helper without an ADMIN/OWNER floor:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});
