import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";

/**
 * POST /api/clients — add one client, or a batch.
 *
 * Until this existed there was no way to create a client anywhere in the
 * product: the 86 that exist came from the one-time v1 registry import, and
 * the Fathom webhook only ever files unmatched recordings for review. That
 * made a newly added coach an account that could never receive a matched
 * recording.
 *
 * Body: a single client object, or `{ clients: [...] }` for a batch — a
 * roster gets entered in one sitting during onboarding, not one at a time.
 */

type ClientInput = {
  name?: unknown;
  email?: unknown;
  secondaryEmails?: unknown;
  company?: unknown;
  phone?: unknown;
  hourlyRate?: unknown;
  billingCadence?: unknown;
  meetingCadence?: unknown;
  notes?: unknown;
};

const BILLING_CADENCES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM_DAYS"];
const MEETING_CADENCES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "AD_HOC"];

export async function POST(request: NextRequest) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  const body = await request.json();
  const rows: ClientInput[] = Array.isArray(body?.clients)
    ? body.clients
    : Array.isArray(body)
      ? body
      : [body];

  if (rows.length === 0) {
    return NextResponse.json({ error: "No clients supplied" }, { status: 400 });
  }

  // Which coach's book do these land in? A COACH may only add to their own —
  // taking coachId from the request body would reopen the hole every scoped
  // read was just closed against. OWNER/ADMIN may add on a coach's behalf.
  let coachId = actor.id;
  if (actor.role !== "COACH" && typeof body?.coachId === "string" && body.coachId) {
    const target = await prisma.coach.findUnique({
      where: { id: body.coachId },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ error: "Coach not found" }, { status: 404 });
    }
    coachId = target.id;
  }

  // The owning coach's rate is the default for their clients; the practice
  // default is the fallback. Rates still freeze onto each TimeEntry at
  // session time — this only sets the client's standing rate.
  const [owningCoach, practice] = await Promise.all([
    prisma.coach.findUnique({ where: { id: coachId }, select: { defaultHourlyRate: true } }),
    prisma.coachSettings.findFirst({ select: { defaultHourlyRate: true } }),
  ]);
  const fallbackRate = owningCoach?.defaultHourlyRate ?? practice?.defaultHourlyRate ?? null;

  const created: Array<{ id: string; name: string; email: string }> = [];
  const failed: Array<{ email: string; error: string }> = [];

  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";

    if (!name || !email.includes("@")) {
      failed.push({ email: email || "(missing)", error: "A name and a valid email are required" });
      continue;
    }

    const rate =
      row.hourlyRate !== undefined && row.hourlyRate !== null && row.hourlyRate !== ""
        ? String(row.hourlyRate)
        : fallbackRate;

    try {
      const client = await prisma.client.create({
        data: {
          coachId,
          name,
          email,
          secondaryEmails: Array.isArray(row.secondaryEmails)
            ? [
                ...new Set(
                  row.secondaryEmails
                    .filter((e: unknown): e is string => typeof e === "string" && e.includes("@"))
                    .map((e: string) => e.trim().toLowerCase()),
                ),
              ]
            : [],
          company: typeof row.company === "string" && row.company.trim() ? row.company.trim() : null,
          phone: typeof row.phone === "string" && row.phone.trim() ? row.phone.trim() : null,
          ...(rate !== null && rate !== undefined ? { hourlyRate: rate as never } : {}),
          ...(typeof row.billingCadence === "string" && BILLING_CADENCES.includes(row.billingCadence)
            ? { billingCadence: row.billingCadence as never }
            : {}),
          ...(typeof row.meetingCadence === "string" && MEETING_CADENCES.includes(row.meetingCadence)
            ? { meetingCadence: row.meetingCadence as never }
            : {}),
          notes: typeof row.notes === "string" && row.notes.trim() ? row.notes.trim() : null,
          status: "ACTIVE",
        },
        select: { id: true, name: true, email: true },
      });
      created.push(client);
    } catch (err) {
      // Email is unique PER COACH now, so this fires only on a duplicate
      // within the same coach's book — the same person coached by two
      // different coaches is legitimate and must not collide.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        failed.push({ email, error: "This coach already has a client with that email" });
      } else {
        failed.push({ email, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  }

  // A partially-successful batch reports both halves rather than failing
  // whole: re-pasting a 30-client roster to fix one typo is miserable.
  const status = created.length === 0 ? 400 : failed.length > 0 ? 207 : 201;
  return NextResponse.json({ created, failed }, { status });
}
