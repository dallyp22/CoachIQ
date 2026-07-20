import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  requireCoach,
  scopeCoachId,
  clientWhere,
  viaClientWhere,
  authzResponse,
} from "@/lib/authz";

interface SyncResult {
  sessionId: string;
  clientId: string;
  success: boolean;
  notebookId?: string;
  error?: string;
}

/**
 * POST /api/nlm-sync/complete
 *
 * Called after the Chrome extension finishes syncing transcripts to NLM.
 * Marks successful sessions as nlmInjected=true and saves any newly
 * created notebook IDs on client records.
 */
export async function POST(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  const body = await request.json();
  const results: SyncResult[] = body.results;

  if (!Array.isArray(results)) {
    return NextResponse.json(
      { error: "results must be an array" },
      { status: 400 }
    );
  }

  let marked = 0;
  let notebooksLinked = 0;
  const errors: Array<{ sessionId: string; error: string }> = [];

  for (const r of results) {
    if (r.success) {
      // updateMany rather than update so an out-of-scope sessionId is a silent
      // no-op instead of a throw that would confirm the row exists.
      const updated = await prisma.session.updateMany({
        where: { id: r.sessionId, ...viaClientWhere(coachId) },
        data: { nlmInjected: true },
      });
      if (updated.count === 0) continue;
      marked++;

      // If a new notebook was created, save it on the client
      if (r.notebookId && r.clientId) {
        const client = await prisma.client.findFirst({
          where: { id: r.clientId, ...clientWhere(coachId) },
          select: { notebookId: true },
        });
        if (client && !client.notebookId) {
          await prisma.client.update({
            where: { id: r.clientId },
            data: { notebookId: r.notebookId },
          });
          notebooksLinked++;
        }
      }
    } else if (r.error) {
      errors.push({ sessionId: r.sessionId, error: r.error });
    }
  }

  // Update last synced timestamp
  await prisma.coachSettings.updateMany({
    data: { nlmLastSynced: new Date() },
  });

  return NextResponse.json({
    status: "completed",
    marked,
    notebooksLinked,
    errors,
  });
}
