import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireCoach, scopeCoachId, canAccessProspect, authzResponse } from "@/lib/authz";
import { logEvent, BillingEvent } from "@/lib/billing/audit";
import { cleanString } from "@/lib/pipeline/stages";

/**
 * POST /api/pipeline/prospects/[id]/convert — closed-won → Client (PRD §6.5).
 *
 * The riskiest write in the module: it mints a billable record. Everything
 * here is inside ONE transaction, because a half-fired convert leaves a
 * prospect marked won with no client behind it, and the billing crons never
 * see the money.
 *
 * Three constraints the original spec missed (PRD §13.2):
 *
 *  1. Client.email is REQUIRED; Prospect.email is not. So this prompts for the
 *     address rather than blocking creation upstream — by the time you have
 *     won a deal you have their email. NEVER coerce a blank to "": clients are
 *     unique on (coachId, email) and a second empty string would collide, with
 *     the duplicate handler then offering to link two strangers.
 *  2. The duplicate lookup must NOT filter on status. Client deletion is a
 *     soft flip to CHURNED and the row keeps its email — a status-filtered
 *     check finds nothing, falls through to create, and hits P2002 anyway.
 *  3. It must key on the SAME coachId the create writes. Prospects carry two
 *     coach columns; checking one and writing the other cannot detect the
 *     collision the unique index will raise.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  let scopedCoachId: string | null;
  try {
    actor = await requireCoach();
    scopedCoachId = scopeCoachId(actor, null);
  } catch (err) {
    return authzResponse(err);
  }
  const { userId } = await auth();

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  const prospect = await prisma.prospect.findUnique({
    where: { id },
    select: {
      id: true,
      coachId: true,
      assignedCoachId: true,
      firstName: true,
      lastName: true,
      company: true,
      email: true,
      phone: true,
      needSummary: true,
      convertedToClientId: true,
      stage: { select: { id: true, name: true, terminal: true } },
    },
  });

  if (!prospect || !canAccessProspect(scopedCoachId, prospect)) {
    return NextResponse.json({ error: "Prospect not found" }, { status: 404 });
  }

  // Idempotent. A double-submitted Convert must not mint a second client —
  // returning the existing link is the honest answer to "convert this".
  if (prospect.convertedToClientId) {
    return NextResponse.json(
      { status: "already_converted", clientId: prospect.convertedToClientId },
      { status: 200 },
    );
  }

  if (prospect.stage.terminal !== "WON") {
    return NextResponse.json(
      { error: `Only a prospect in a won stage can be converted — this one is in "${prospect.stage.name}"` },
      { status: 400 },
    );
  }

  // (1) The address. Body wins so the UI can supply one the prospect lacked.
  const email = (cleanString(body?.email) ?? prospect.email ?? "").toLowerCase();
  if (!email.includes("@")) {
    return NextResponse.json(
      {
        error: "email_required",
        message: "This prospect has no email address. Client records require one — add it to convert.",
      },
      { status: 422 },
    );
  }

  // (3) The client lands in the ASSIGNED coach's book when there is one — they
  // are the person who will actually coach them — else the owner's. Whatever
  // this resolves to is what both the duplicate check and the create use.
  const targetCoachId = prospect.assignedCoachId ?? prospect.coachId;

  // May the actor see rows in that book? A COACH can own a prospect they have
  // assigned to someone else, and the duplicate response below names a client
  // — echoing it would disclose another coach's client record (and hand over a
  // usable id) to someone who can never otherwise see it.
  const maySeeTargetBook = scopedCoachId === null || scopedCoachId === targetCoachId;

  // (2) No status filter: a CHURNED client still holds the email and still
  // trips the unique index.
  const existingClient = await prisma.client.findFirst({
    where: { coachId: targetCoachId, email },
    select: { id: true, name: true, status: true },
  });

  // Prospect.convertedToClientId is UNIQUE — one client can be the conversion
  // target of at most one prospect. So if this client is already linked from
  // another prospect, offering "link to existing" would fail on the prospect
  // index, not the client one, and the P2002 handler below would report the
  // wrong cause ("a client was just created") for a collision that is
  // permanent. Detect it here and say the true thing instead.
  const alreadyLinked = existingClient
    ? await prisma.prospect.findFirst({
        where: { convertedToClientId: existingClient.id, id: { not: id } },
        select: { id: true, firstName: true, lastName: true },
      })
    : null;

  if (existingClient && !body?.linkToExistingClientId) {
    // Do not guess. Re-coaching a former client is normal, and so is a typo;
    // the two need opposite outcomes, and only a human knows which.
    return NextResponse.json(
      {
        error: "duplicate_email",
        message: !maySeeTargetBook
          ? "That address is already in use in the assigned coach's book. Ask them to resolve it, or use a different address."
          : alreadyLinked
            ? `${existingClient.name} already exists with that address, and is already linked to the prospect "${`${alreadyLinked.firstName} ${alreadyLinked.lastName}`.trim()}". Use a different address, or delete this duplicate prospect.`
            : `${existingClient.name} already exists in this coach's book with that address.`,
        // Only offer the link when it can actually succeed AND the actor is
        // allowed to see the client it names.
        ...(alreadyLinked || !maySeeTargetBook ? {} : { existingClient }),
      },
      { status: 409 },
    );
  }

  if (body?.linkToExistingClientId && alreadyLinked) {
    return NextResponse.json(
      {
        error: "already_linked",
        message: `That client is already linked to another prospect. A client can only be converted from one prospect.`,
      },
      { status: 409 },
    );
  }

  if (body?.linkToExistingClientId && !maySeeTargetBook) {
    return NextResponse.json({ error: "Prospect not found" }, { status: 404 });
  }

  if (body?.linkToExistingClientId && body.linkToExistingClientId !== existingClient?.id) {
    return NextResponse.json(
      { error: "The client to link to no longer matches this prospect's email" },
      { status: 409 },
    );
  }

  const coach = await prisma.coach.findUnique({
    where: { id: targetCoachId },
    select: { defaultHourlyRate: true },
  });
  const practice = await prisma.coachSettings.findFirst({ select: { defaultHourlyRate: true } });
  const rate = coach?.defaultHourlyRate ?? practice?.defaultHourlyRate ?? null;

  const name = `${prospect.firstName} ${prospect.lastName}`.trim();

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Link to the existing client, or create a new one. Both paths end with
      // the prospect pointing at a client, inside this transaction.
      const clientId =
        existingClient?.id ??
        (
          await tx.client.create({
            data: {
              coachId: targetCoachId,
              name,
              email,
              phone: prospect.phone,
              company: prospect.company,
              // Carried across so the "description of need" survives into the
              // coaching relationship — the reason Client.needSummary exists.
              needSummary: prospect.needSummary,
              status: "ACTIVE",
              ...(rate !== null ? { hourlyRate: rate as never } : {}),
            },
            select: { id: true },
          })
        ).id;

      await tx.prospect.update({
        where: { id },
        data: { convertedToClientId: clientId },
      });

      await logEvent(tx, {
        event: BillingEvent.PROSPECT_CONVERTED,
        actor: userId,
        clientId,
        payload: {
          prospectId: id,
          name,
          coachId: targetCoachId,
          linked: Boolean(existingClient),
        },
      });

      return { clientId, linked: Boolean(existingClient) };
    });

    return NextResponse.json(
      {
        status: result.linked ? "linked" : "created",
        clientId: result.clientId,
        // The UI deep-links here to finish billing setup (cadence, Stripe).
        clientPath: `/clients/${result.clientId}`,
      },
      { status: 201 },
    );
  } catch (err) {
    // The race: another request created a client with this email between the
    // check above and the create. The unique index is the real guard; this
    // turns it into the same 409 the pre-check gives.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Two different unique indexes can raise here and they mean opposite
      // things. clients(coachId,email) is the concurrent-convert race and is
      // retryable; prospects.convertedToClientId means the target client is
      // already the conversion of another prospect, which no retry fixes.
      const target = String(err.meta?.target ?? "");
      if (target.includes("convertedToClientId")) {
        return NextResponse.json(
          {
            error: "already_linked",
            message: "That client is already linked to another prospect.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error: "duplicate_email",
          message: "A client with that email was just created in this coach's book.",
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
