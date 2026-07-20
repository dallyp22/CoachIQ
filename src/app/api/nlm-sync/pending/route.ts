import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  requireCoach,
  scopeCoachId,
  viaClientWhere,
  authzResponse,
} from "@/lib/authz";

/**
 * GET /api/nlm-sync/pending?clientId={optional}
 *
 * Returns sessions that haven't been synced to NotebookLM yet,
 * grouped by client. Only includes sessions that have a transcript.
 */
export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  const clientId = request.nextUrl.searchParams.get("clientId");

  const sessions = await prisma.session.findMany({
    where: {
      nlmInjected: false,
      transcript: { isNot: null },
      ...(clientId ? { clientId } : {}),
      ...viaClientWhere(coachId),
    },
    include: {
      client: { select: { id: true, name: true, notebookId: true } },
      transcript: { select: { fullText: true } },
    },
    orderBy: { date: "asc" },
  });

  // Group by client
  const clientMap = new Map<
    string,
    {
      clientId: string;
      clientName: string;
      notebookId: string | null;
      pendingSessions: Array<{
        sessionId: string;
        title: string;
        date: string;
        transcriptText: string;
      }>;
    }
  >();

  for (const s of sessions) {
    if (!s.transcript) continue;

    let entry = clientMap.get(s.clientId);
    if (!entry) {
      entry = {
        clientId: s.client.id,
        clientName: s.client.name,
        notebookId: s.client.notebookId,
        pendingSessions: [],
      };
      clientMap.set(s.clientId, entry);
    }
    entry.pendingSessions.push({
      sessionId: s.id,
      title: s.title,
      date: s.date.toISOString().split("T")[0],
      transcriptText: s.transcript.fullText,
    });
  }

  return NextResponse.json({
    clients: Array.from(clientMap.values()),
    totalPending: sessions.length,
  });
}
