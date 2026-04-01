import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

interface Segment {
  speaker?: { display_name?: string };
  text?: string;
}

/**
 * GET /api/analytics/practice-insights — practice-wide coaching patterns.
 * Aggregates talk ratios, question ratios, and ownership across all clients.
 */
export async function GET() {
  try {
    const settings = await prisma.coachSettings.findFirst({
      select: { coachName: true },
    });
    const coachFirstName = (settings?.coachName || "Todd").split(" ")[0].toLowerCase();

    // Get all clients with sessions that have transcripts
    const clients = await prisma.client.findMany({
      where: { status: { not: "CHURNED" }, sessionCount: { gte: 3 } },
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
        where: { clientId: client.id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { rawSegments: true },
      });

      let clientTalkSum = 0;
      let questionSum = 0;
      let ownershipSum = 0;
      let validSessions = 0;

      for (const t of transcripts) {
        const segments = t.rawSegments as Segment[] | null;
        if (!segments || !Array.isArray(segments) || segments.length === 0) continue;

        let clientWords = 0;
        let coachWords = 0;
        const clientTexts: string[] = [];

        for (const seg of segments) {
          const text = seg.text?.trim() || "";
          if (!text) continue;
          const speaker = seg.speaker?.display_name?.toLowerCase() || "";
          const isCoach = speaker.includes(coachFirstName) || speaker.includes("todd") || speaker === "unknown";
          const wc = text.split(/\s+/).length;

          if (isCoach) coachWords += wc;
          else { clientWords += wc; clientTexts.push(text); }
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
