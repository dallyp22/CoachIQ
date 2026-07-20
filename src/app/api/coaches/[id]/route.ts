import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { encryptOptional } from "@/lib/secrets";
import { provisionCoach, outstandingActions } from "@/lib/coach-onboarding";
import { DEFAULT_COACHING_FILTER } from "@/lib/google-calendar";

/**
 * PATCH /api/coaches/[id] — edit a coach, or retry a failed provisioning step.
 *
 * `{ retry: true }` re-runs provisioning. Every step is idempotent, so a
 * retry cannot send a second invitation or register a second webhook — the
 * latter would ingest and bill every meeting twice.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let actor;
  try {
    actor = await requireCoach("ADMIN");
  } catch (err) {
    return authzResponse(err);
  }

  const { id } = await params;
  const body = await request.json();

  const coach = await prisma.coach.findUnique({ where: { id } });
  if (!coach) {
    return NextResponse.json({ error: "Coach not found" }, { status: 404 });
  }

  if (body.retry === true) {
    const result = await provisionCoach(coach.id);
    return NextResponse.json({ ...result, outstanding: outstandingActions(result, coach) });
  }

  const data: Record<string, unknown> = {};

  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();

  if (typeof body.role === "string") {
    if (actor.role !== "OWNER") {
      return NextResponse.json(
        { error: "Only the practice owner can change roles" },
        { status: 403 },
      );
    }
    // Demoting the last OWNER would lock the Danger Zone for everyone.
    if (coach.role === "OWNER" && body.role !== "OWNER") {
      const owners = await prisma.coach.count({ where: { role: "OWNER" } });
      if (owners <= 1) {
        return NextResponse.json(
          { error: "The practice must keep at least one owner" },
          { status: 400 },
        );
      }
    }
    if (["OWNER", "ADMIN", "COACH"].includes(body.role)) data.role = body.role;
  }

  if (typeof body.status === "string" && ["INVITED", "ACTIVE", "INACTIVE"].includes(body.status)) {
    if (coach.role === "OWNER" && body.status === "INACTIVE") {
      return NextResponse.json(
        { error: "The practice owner cannot be deactivated" },
        { status: 400 },
      );
    }
    data.status = body.status;
  }

  if (Array.isArray(body.workEmails)) {
    data.workEmails = [
      ...new Set(
        body.workEmails
          .filter((e: unknown): e is string => typeof e === "string" && e.includes("@"))
          .map((e: string) => e.trim().toLowerCase()),
      ),
    ];
  }

  if (body.coachingTitleFilter !== undefined) {
    const filter =
      typeof body.coachingTitleFilter === "string" && body.coachingTitleFilter.trim()
        ? body.coachingTitleFilter.trim()
        : null;
    if (filter) {
      try {
        new RegExp(filter, "i");
      } catch {
        return NextResponse.json(
          {
            error: `Coaching title filter is not a valid regular expression. Example: ${DEFAULT_COACHING_FILTER}`,
          },
          { status: 400 },
        );
      }
    }
    data.coachingTitleFilter = filter;
  }

  for (const field of ["googleCalendarId", "driveRootFolderId"] as const) {
    if (body[field] !== undefined) {
      data[field] =
        typeof body[field] === "string" && body[field].trim() ? body[field].trim() : null;
    }
  }

  if (body.calendarSyncEnabled !== undefined) {
    data.calendarSyncEnabled = Boolean(body.calendarSyncEnabled);
  }

  if (body.defaultHourlyRate !== undefined) {
    data.defaultHourlyRate =
      body.defaultHourlyRate === null || body.defaultHourlyRate === ""
        ? null
        : String(body.defaultHourlyRate);
  }

  // Secrets are write-only: a new key replaces the stored one, and an absent
  // field leaves it untouched. They are never returned by any endpoint.
  if (typeof body.fathomApiKey === "string" && body.fathomApiKey.trim()) {
    data.fathomApiKey = encryptOptional(body.fathomApiKey.trim());
    // A new key invalidates the webhook registered with the old one.
    data.fathomWebhookId = null;
  }
  if (typeof body.fathomWebhookSecret === "string" && body.fathomWebhookSecret.trim()) {
    data.fathomWebhookSecret = encryptOptional(body.fathomWebhookSecret.trim());
    data.fathomStatus = "OK";
  }

  await prisma.coach.update({ where: { id }, data });

  return NextResponse.json({ id, status: "updated" });
}
