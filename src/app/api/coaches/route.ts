import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { encryptOptional } from "@/lib/secrets";
import { provisionCoach, outstandingActions } from "@/lib/coach-onboarding";
import { DEFAULT_COACHING_FILTER } from "@/lib/google-calendar";

/**
 * GET /api/coaches — the Coaches list. ADMIN and above.
 *
 * Never returns the encrypted secret columns, only whether they are set.
 */
export async function GET() {
  try {
    await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

  const coaches = await prisma.coach.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      loginEmail: true,
      workEmails: true,
      role: true,
      status: true,
      inviteStatus: true,
      fathomStatus: true,
      googleCalendarId: true,
      driveRootFolderId: true,
      coachingTitleFilter: true,
      defaultHourlyRate: true,
      fathomWebhookId: true,
      clerkUserId: true,
      _count: { select: { clients: true } },
    },
  });

  return NextResponse.json({
    coaches: coaches.map((c) => ({
      id: c.id,
      name: c.name,
      loginEmail: c.loginEmail,
      workEmails: c.workEmails,
      role: c.role,
      status: c.status,
      inviteStatus: c.inviteStatus,
      fathomStatus: c.fathomStatus,
      hasSignedIn: Boolean(c.clerkUserId),
      calendarConfigured: Boolean(c.googleCalendarId),
      driveConfigured: Boolean(c.driveRootFolderId),
      fathomConnected: Boolean(c.fathomWebhookId),
      coachingTitleFilter: c.coachingTitleFilter,
      defaultHourlyRate: c.defaultHourlyRate ? Number(c.defaultHourlyRate) : null,
      clientCount: c._count.clients,
    })),
  });
}

/**
 * POST /api/coaches — add a coach and provision their account.
 *
 * Creates the row first, then attempts the Clerk invitation and Fathom
 * webhook registration. Both are best-effort and retryable: a coach who
 * exists with a FAILED chip is recoverable, a coach who was rolled back
 * after Clerk already emailed them is not.
 */
export async function POST(request: NextRequest) {
  let actor;
  try {
    actor = await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

  const body = await request.json();

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const loginEmail =
    typeof body.loginEmail === "string" ? body.loginEmail.trim().toLowerCase() : "";

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!loginEmail.includes("@")) {
    return NextResponse.json({ error: "A valid login email is required" }, { status: 400 });
  }

  const role = body.role === "ADMIN" || body.role === "COACH" ? body.role : "COACH";
  // Only an OWNER may mint another practice-wide account.
  if (role === "ADMIN" && actor.role !== "OWNER") {
    return NextResponse.json(
      { error: "Only the practice owner can grant ADMIN access" },
      { status: 403 },
    );
  }

  // Validate the regex at save time. Storing a broken pattern would surface
  // later as a webhook that drops recordings or a cron that fails all day.
  const coachingTitleFilter =
    typeof body.coachingTitleFilter === "string" && body.coachingTitleFilter.trim()
      ? body.coachingTitleFilter.trim()
      : null;
  if (coachingTitleFilter) {
    try {
      new RegExp(coachingTitleFilter, "i");
    } catch {
      return NextResponse.json(
        {
          error: `Coaching title filter is not a valid regular expression. Example: ${DEFAULT_COACHING_FILTER}`,
        },
        { status: 400 },
      );
    }
  }

  const workEmails: string[] = Array.isArray(body.workEmails)
    ? [...new Set(
        (body.workEmails as unknown[])
          .filter((e): e is string => typeof e === "string" && e.includes("@"))
          .map((e) => e.trim().toLowerCase()),
      )]
    : [];
  // The login address is almost always also a recording address; seeding it
  // means attendee-exclusion works before anyone thinks about work emails.
  if (!workEmails.includes(loginEmail)) workEmails.unshift(loginEmail);

  const existing = await prisma.coach.findUnique({ where: { loginEmail } });
  if (existing) {
    return NextResponse.json(
      { error: "A coach with that login email already exists" },
      { status: 409 },
    );
  }

  const coach = await prisma.coach.create({
    data: {
      name,
      loginEmail,
      workEmails,
      role,
      status: "INVITED",
      fathomApiKey: encryptOptional(
        typeof body.fathomApiKey === "string" ? body.fathomApiKey.trim() : null,
      ),
      // A manually-pasted signing secret, for when the API key path is skipped.
      fathomWebhookSecret: encryptOptional(
        typeof body.fathomWebhookSecret === "string" ? body.fathomWebhookSecret.trim() : null,
      ),
      googleCalendarId:
        typeof body.googleCalendarId === "string" && body.googleCalendarId.trim()
          ? body.googleCalendarId.trim()
          : null,
      driveRootFolderId:
        typeof body.driveRootFolderId === "string" && body.driveRootFolderId.trim()
          ? body.driveRootFolderId.trim()
          : null,
      coachingTitleFilter,
      defaultHourlyRate:
        body.defaultHourlyRate !== undefined &&
        body.defaultHourlyRate !== null &&
        body.defaultHourlyRate !== ""
          ? String(body.defaultHourlyRate)
          : null,
    },
  });

  const result = await provisionCoach(coach.id);

  return NextResponse.json(
    {
      id: coach.id,
      name: coach.name,
      ...result,
      outstanding: outstandingActions(result, coach),
    },
    { status: 201 },
  );
}
