import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCoach, authzResponse } from "@/lib/authz";
import { readJsonBody, cleanString } from "@/lib/pipeline/stages";
import { isValidType } from "@/lib/feedback";
import { APP_VERSION } from "@/lib/version";

/**
 * POST /api/feedback — a coach files a bug or feature request.
 *
 * Any coach may submit, and it is always their own report (submittedById is the
 * actor, never read from the body). The environment fields — pageUrl, appVersion,
 * userAgent — are captured here so the reporter never has to describe their
 * setup; a plainly-worded report still arrives with the context to reproduce it.
 */
export async function POST(request: NextRequest) {
  let actor;
  try {
    actor = await requireCoach();
  } catch (err) {
    return authzResponse(err);
  }

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const type = body.type;
  if (!isValidType(type)) {
    return NextResponse.json({ error: "type must be BUG or FEATURE" }, { status: 400 });
  }

  const title = cleanString(body.title);
  if (!title) {
    return NextResponse.json({ error: "A title is required" }, { status: 400 });
  }
  const bodyText = cleanString(body.body);
  if (!bodyText) {
    return NextResponse.json({ error: "A description is required" }, { status: 400 });
  }

  // appVersion is stamped server-side (authoritative); pageUrl is just context
  // the client knows and we don't, so we take it as given but bound its length.
  const pageUrl = cleanString(body.pageUrl)?.slice(0, 500) ?? null;
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;

  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.feedbackItem.create({
      data: {
        type,
        title: title.slice(0, 200),
        body: bodyText.slice(0, 5000),
        submittedById: actor.id,
        pageUrl,
        appVersion: APP_VERSION,
        userAgent,
      },
      select: { id: true },
    });

    // Filed-into-SUBMITTED is a real transition (fromStage null), so the
    // timeline shows where the item entered rather than inferring it.
    await tx.feedbackStageChange.create({
      data: { feedbackId: created.id, fromStage: null, toStage: "SUBMITTED", changedById: actor.id },
    });

    return created;
  });

  return NextResponse.json({ id: item.id }, { status: 201 });
}
