import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  requireCoach,
  scopeCoachId,
  clientWhere,
  viaClientWhere,
  authzResponse,
} from "@/lib/authz";

interface ParsedTurn {
  speaker: string;
  text: string;
}

function parseTranscriptTurns(fullText: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  const regex = /^\[[\d:]+\]\s+(.+?):\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(fullText)) !== null) {
    const speaker = match[1].trim();
    const text = match[2].trim();
    if (speaker && text && text.length > 2) turns.push({ speaker, text });
  }
  return turns;
}

/**
 * GET /api/analytics/practice-insights — practice-wide coaching patterns.
 * Aggregates talk ratios, question ratios, and ownership across all clients.
 */
export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  try {
    const settings = await prisma.coachSettings.findFirst({
      select: { coachName: true },
    });
    const coachFirstName = (settings?.coachName || "Todd").split(" ")[0].toLowerCase();

    // Get all clients with sessions that have transcripts
    const clients = await prisma.client.findMany({
      where: { status: { not: "CHURNED" }, sessionCount: { gte: 3 }, ...clientWhere(coachId) },
      select: { id: true, name: true },
    });

    // For each client, compute aggregates from their latest 10 sessions
    const clientInsights: Array<{
      clientId: string;
      clientName: string;
      avgClientTalk: number;
      avgQuestionRatio: number;
      avgOwnership: number;
      sessionCount: number;
    }> = [];

    let totalTalk = 0;
    let totalQuestions = 0;
    let totalOwnership = 0;
    let totalClients = 0;

    for (const client of clients) {
      const transcripts = await prisma.transcript.findMany({
        where: { clientId: client.id, ...viaClientWhere(coachId) },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { fullText: true },
      });

      let clientTalkSum = 0;
      let questionSum = 0;
      let ownershipSum = 0;
      let validSessions = 0;

      for (const t of transcripts) {
        const turns = parseTranscriptTurns(t.fullText);
        if (turns.length < 5) continue;

        let clientWords = 0;
        let coachWords = 0;
        const clientTexts: string[] = [];

        for (const turn of turns) {
          const speaker = turn.speaker.toLowerCase();
          const isCoach = speaker.includes(coachFirstName) || speaker.includes("todd") || speaker === "unknown";
          const wc = turn.text.split(/\s+/).length;

          if (isCoach) coachWords += wc;
          else { clientWords += wc; clientTexts.push(turn.text); }
        }

        const total = clientWords + coachWords;
        if (total < 50) continue; // Skip very short sessions

        clientTalkSum += (clientWords / total) * 100;

        // Question ratio
        const fullText = clientTexts.join(" ");
        const sentences = fullText.split(/[.!?]+/).filter((s) => s.trim().length > 3);
        const questions = (fullText.match(/\?/g) || []).length;
        if (sentences.length > 0) {
          questionSum += (questions / sentences.length) * 100;
        }

        // Ownership
        const lower = fullText.toLowerCase();
        const words = lower.split(/\s+/);
        const ownWords = new Set(["i", "i'm", "i've", "i'll", "my", "mine", "we", "we're", "our"]);
        const distWords = new Set(["they", "they're", "them", "their", "theirs"]);
        let own = 0, dist = 0;
        for (const w of words) { if (ownWords.has(w)) own++; if (distWords.has(w)) dist++; }
        const pronTotal = own + dist;
        ownershipSum += pronTotal > 0 ? (own / pronTotal) * 100 : 50;

        validSessions++;
      }

      if (validSessions >= 2) {
        const avg = {
          clientId: client.id,
          clientName: client.name,
          avgClientTalk: Math.round(clientTalkSum / validSessions),
          avgQuestionRatio: Math.round(questionSum / validSessions),
          avgOwnership: Math.round(ownershipSum / validSessions),
          sessionCount: validSessions,
        };
        clientInsights.push(avg);
        totalTalk += avg.avgClientTalk;
        totalQuestions += avg.avgQuestionRatio;
        totalOwnership += avg.avgOwnership;
        totalClients++;
      }
    }

    // Sort for leaderboards
    const byTalkTime = [...clientInsights].sort((a, b) => b.avgClientTalk - a.avgClientTalk);
    const byQuestions = [...clientInsights].sort((a, b) => b.avgQuestionRatio - a.avgQuestionRatio);
    const byOwnership = [...clientInsights].sort((a, b) => b.avgOwnership - a.avgOwnership);

    return NextResponse.json({
      practiceAverages: {
        clientTalkPercent: totalClients > 0 ? Math.round(totalTalk / totalClients) : 0,
        questionRatio: totalClients > 0 ? Math.round(totalQuestions / totalClients) : 0,
        ownershipPercent: totalClients > 0 ? Math.round(totalOwnership / totalClients) : 0,
      },
      clientCount: totalClients,
      topTalkers: byTalkTime.slice(0, 5),
      topQuestioners: byQuestions.slice(0, 5),
      topOwnership: byOwnership.slice(0, 5),
      lowOwnership: byOwnership.slice(-5).reverse(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
