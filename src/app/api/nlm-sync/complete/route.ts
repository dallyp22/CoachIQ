import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
      await prisma.session.update({
        where: { id: r.sessionId },
        data: { nlmInjected: true },
      });
      marked++;

      // If a new notebook was created, save it on the client
      if (r.notebookId && r.clientId) {
        const client = await prisma.client.findUnique({
          where: { id: r.clientId },
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
