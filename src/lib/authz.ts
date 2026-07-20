import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { CoachRole } from "@/generated/prisma/enums";

/**
 * Who is asking, and what may they see.
 *
 *   Clerk userId ──► coaches.clerkUserId ──► ResolvedCoach   (fast path, 1 indexed read)
 *        │ no row
 *        ▼
 *   Clerk invitation publicMetadata.coachId ──► link + stamp  (first sign-in)
 *        │ no metadata
 *        ▼
 *   match Clerk email to coaches.loginEmail ──► link + stamp  (legacy / Todd)
 *        │ no match
 *        ▼
 *   403 no-access
 *
 * Before this existed, Clerk auth was presence-only: any signed-in account saw
 * every coach's clients, transcripts and invoices.
 */

export type ResolvedCoach = {
  id: string;
  name: string;
  loginEmail: string;
  workEmails: string[];
  role: CoachRole;
  coachingTitleFilter: string | null;
  googleCalendarId: string | null;
  calendarSyncEnabled: boolean;
  driveRootFolderId: string | null;
  defaultHourlyRate: unknown; // Prisma Decimal | null
};

const COACH_SELECT = {
  id: true,
  name: true,
  loginEmail: true,
  workEmails: true,
  role: true,
  status: true,
  coachingTitleFilter: true,
  googleCalendarId: true,
  calendarSyncEnabled: true,
  driveRootFolderId: true,
  defaultHourlyRate: true,
} as const;

/** OWNER outranks ADMIN outranks COACH. */
const ROLE_RANK: Record<CoachRole, number> = { COACH: 0, ADMIN: 1, OWNER: 2 };

export class AuthzError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: "unauthenticated" | "no_coach" | "inactive" | "forbidden"
  ) {
    super(message);
    this.name = "AuthzError";
  }
}

/**
 * Resolve the signed-in user to a coach, or throw AuthzError.
 *
 * `minRole` is the LEAST privileged role allowed — requireCoach("ADMIN")
 * admits ADMIN and OWNER. One indexed point read per request; deliberately
 * not cached so deactivating a coach or changing a role takes effect on the
 * very next request rather than after a TTL.
 */
export async function requireCoach(minRole: CoachRole = "COACH"): Promise<ResolvedCoach> {
  const { userId } = await auth();
  if (!userId) {
    throw new AuthzError(401, "Not signed in.", "unauthenticated");
  }

  let row = await prisma.coach.findUnique({
    where: { clerkUserId: userId },
    select: COACH_SELECT,
  });

  if (!row) {
    row = await linkClerkUser(userId);
  }

  if (!row) {
    throw new AuthzError(
      403,
      "This account is not registered as a coach on this practice.",
      "no_coach"
    );
  }
  if (row.status === "INACTIVE") {
    throw new AuthzError(403, "This coach account has been deactivated.", "inactive");
  }
  if (ROLE_RANK[row.role] < ROLE_RANK[minRole]) {
    throw new AuthzError(403, `Requires ${minRole} access.`, "forbidden");
  }

  const { status: _status, ...coach } = row;
  return coach;
}

/**
 * First sign-in: bind the Clerk account to its Coach row.
 *
 * Prefers the coachId stamped into the Clerk invitation's public metadata —
 * it rides the invite link, so it survives the coach signing up with a
 * different email than we invited (Google OAuth commonly does this). Email
 * matching is the fallback for accounts that predate invitations (Todd).
 */
async function linkClerkUser(userId: string) {
  const user = await currentUser();
  if (!user) return null;

  const invitedCoachId = user.publicMetadata?.coachId;
  const emails = user.emailAddresses.map((e) => e.emailAddress.toLowerCase());

  const candidate = await prisma.coach.findFirst({
    where:
      typeof invitedCoachId === "string" && invitedCoachId.length > 0
        ? { id: invitedCoachId }
        : { loginEmail: { in: emails, mode: "insensitive" } },
    select: { id: true, clerkUserId: true },
  });
  if (!candidate) return null;

  // Another account already owns this coach row — never silently re-point it.
  if (candidate.clerkUserId && candidate.clerkUserId !== userId) return null;

  try {
    return await prisma.coach.update({
      where: { id: candidate.id },
      data: { clerkUserId: userId, status: "ACTIVE" },
      select: COACH_SELECT,
    });
  } catch {
    // Concurrent first requests race on the unique clerkUserId; whichever
    // lost re-reads the row the winner just wrote.
    return prisma.coach.findUnique({ where: { clerkUserId: userId }, select: COACH_SELECT });
  }
}

/** Turn an AuthzError into the response a route should return. */
export function authzResponse(err: unknown): NextResponse {
  if (err instanceof AuthzError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  throw err;
}

// ─── Scoping ──────────────────────────────────────────

/**
 * The coachId every query in this request must filter by, or null when the
 * caller may legitimately see the whole practice.
 *
 * A COACH is pinned to their own id — the `requested` parameter is ignored
 * for them, so no amount of query-string fiddling widens their view.
 * OWNER/ADMIN see everything by default and may narrow to one coach.
 */
export function scopeCoachId(coach: ResolvedCoach, requested?: string | null): string | null {
  if (coach.role === "COACH") return coach.id;
  return requested && requested.length > 0 ? requested : null;
}

/**
 * May the caller act on a single row owned by `rowCoachId`?
 *
 * Callers should answer a failure with 404, not 403: telling a coach that a
 * client exists but belongs to someone else is itself a disclosure.
 */
export function canAccess(coachId: string | null, rowCoachId: string | null | undefined): boolean {
  if (coachId === null) return true;
  return rowCoachId === coachId;
}

/** Where-fragment for the Client model itself. */
export function clientWhere(coachId: string | null): { coachId?: string } {
  return coachId ? { coachId } : {};
}

/** Where-fragment for models that reach a coach through `client` (Session, Transcript, TimeEntry, PrepBrief). */
export function viaClientWhere(coachId: string | null): { client?: { coachId: string } } {
  return coachId ? { client: { coachId } } : {};
}

/**
 * Invoices carry a clientId XOR a groupId, so a coach filter has to cover
 * both paths — filtering on `client` alone silently drops every group invoice.
 */
export function invoiceWhere(
  coachId: string | null
): { OR?: Array<{ client: { coachId: string } } | { group: { coachId: string } }> } {
  return coachId ? { OR: [{ client: { coachId } }, { group: { coachId } }] } : {};
}

// ─── Effective configuration ──────────────────────────

export type PracticeSettings = {
  coachingTitleFilter: string | null;
  timezone: string;
  defaultHourlyRate: unknown;
};

export type CoachConfig = {
  coachingTitleFilter: string | null;
  googleCalendarId: string | null;
  calendarSyncEnabled: boolean;
  timezone: string;
  defaultHourlyRate: unknown;
  /** Addresses to exclude when picking the client attendee on an event. */
  coachEmails: string[];
};

/** Treat blank strings as absent: an empty regex filter matches everything. */
function firstPresent(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Merge a coach's overrides over the practice defaults. One resolver so the
 * blank-vs-null decision is made once, rather than sixteen call sites each
 * choosing `??` or `||` and disagreeing about empty strings.
 */
export function resolveCoachConfig(
  coach: Pick<
    ResolvedCoach,
    | "coachingTitleFilter"
    | "googleCalendarId"
    | "calendarSyncEnabled"
    | "defaultHourlyRate"
    | "loginEmail"
    | "workEmails"
  >,
  practice: PracticeSettings | null
): CoachConfig {
  const emails = new Set<string>();
  for (const e of [coach.loginEmail, ...(coach.workEmails ?? [])]) {
    if (typeof e === "string" && e.trim().length > 0) emails.add(e.trim().toLowerCase());
  }

  return {
    coachingTitleFilter: firstPresent(
      coach.coachingTitleFilter,
      practice?.coachingTitleFilter
    ),
    googleCalendarId: firstPresent(coach.googleCalendarId),
    // Boolean: false is a real setting, so never fall through on it.
    calendarSyncEnabled: coach.calendarSyncEnabled,
    timezone: practice?.timezone ?? "America/Chicago",
    defaultHourlyRate: coach.defaultHourlyRate ?? practice?.defaultHourlyRate ?? null,
    coachEmails: [...emails],
  };
}
