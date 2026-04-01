import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

interface Segment {
  speaker?: { display_name?: string };
  timestamp?: string;
  text?: string;
}

interface SessionMetrics {
  sessionId: string;
  date: string;
  title: string;
  // Talk ratios
  clientTalkPercent: number;
  coachTalkPercent: number;
  totalTurns: number;
  clientTurns: number;
  coachTurns: number;
  clientWordCount: number;
  coachWordCount: number;
  // Language patterns (client only)
  questionRatio: number;
  pronounOwnership: number;
  // Lexical diversity (client only)
  lexicalDiversity: number;
  // Topic drift
  topicSimilarity: number | null;
}

/**
 * GET /api/analytics/session-metrics — per-session coaching metrics for a client.
 *
 * Query params:
 *   clientId=UUID (required)
 *   limit=number (default 50)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");
    const limit = Math.min(Number(searchParams.get("limit") || "50"), 100);

    if (!clientId) {
      return NextResponse.json({ error: "clientId is required" }, { status: 400 });
    }

    // Get coach name for speaker identification
    const settings = await prisma.coachSettings.findFirst({
      select: { coachName: true },
    });
    const coachName = settings?.coachName?.toLowerCase() || "todd";
    const coachFirstName = coachName.split(" ")[0];

    // Fetch sessions with transcripts ordered chronologically
    const sessions = await prisma.session.findMany({
      where: { clientId },
      orderBy: { date: "asc" },
      take: limit,
      select: {
        id: true,
        date: true,
        title: true,
        transcript: {
          select: {
            rawSegments: true,
          },
        },
      },
    });

    // Fetch topic similarity between consecutive sessions via embeddings
    const similarities = await computeTopicSimilarities(clientId, limit);

    const metrics: SessionMetrics[] = [];

    for (const session of sessions) {
      const segments = session.transcript?.rawSegments as Segment[] | null;

      if (!segments || !Array.isArray(segments) || segments.length === 0) {
        continue;
      }

      // Identify coach vs client turns
      let clientWords = 0;
      let coachWords = 0;
      let clientTurns = 0;
      let coachTurns = 0;
      const clientTexts: string[] = [];

      for (const seg of segments) {
        const text = seg.text?.trim() || "";
        if (!text) continue;

        const speaker = seg.speaker?.display_name?.toLowerCase() || "";
        const isCoach =
          speaker.includes(coachFirstName) ||
          speaker.includes("todd") ||
          speaker === "unknown";

        const wordCount = text.split(/\s+/).length;

        if (isCoach) {
          coachWords += wordCount;
          coachTurns++;
        } else {
          clientWords += wordCount;
          clientTurns++;
          clientTexts.push(text);
        }
      }

      const totalWords = clientWords + coachWords;
      const clientTalkPercent = totalWords > 0 ? Math.round((clientWords / totalWords) * 100) : 0;
      const coachTalkPercent = totalWords > 0 ? 100 - clientTalkPercent : 0;

      // Language patterns from client text
      const clientFullText = clientTexts.join(" ");
      const questionRatio = computeQuestionRatio(clientFullText);
      const pronounOwnership = computePronounOwnership(clientFullText);
      const lexicalDiversity = computeLexicalDiversity(clientFullText);

      // Topic similarity from pre-computed map
      const topicSimilarity = similarities.get(session.id) ?? null;

      metrics.push({
        sessionId: session.id,
        date: session.date.toISOString(),
        title: session.title,
        clientTalkPercent,
        coachTalkPercent,
        totalTurns: clientTurns + coachTurns,
        clientTurns,
        coachTurns,
        clientWordCount: clientWords,
        coachWordCount: coachWords,
        questionRatio,
        pronounOwnership,
        lexicalDiversity,
        topicSimilarity,
      });
    }

    // Compute practice-wide averages for this client
    const avgTalkPercent = metrics.length > 0
      ? Math.round(metrics.reduce((s, m) => s + m.clientTalkPercent, 0) / metrics.length)
      : 0;
    const avgQuestionRatio = metrics.length > 0
      ? Math.round(metrics.reduce((s, m) => s + m.questionRatio, 0) / metrics.length)
      : 0;
    const avgOwnership = metrics.length > 0
      ? +(metrics.reduce((s, m) => s + m.pronounOwnership, 0) / metrics.length).toFixed(2)
      : 0;
    const avgLexical = metrics.length > 0
      ? +(metrics.reduce((s, m) => s + m.lexicalDiversity, 0) / metrics.length).toFixed(3)
      : 0;

    return NextResponse.json({
      clientId,
      sessionCount: metrics.length,
      metrics,
      averages: {
        clientTalkPercent: avgTalkPercent,
        questionRatio: avgQuestionRatio,
        pronounOwnership: avgOwnership,
        lexicalDiversity: avgLexical,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── Helpers ──────────────────────────────────────────────

function computeQuestionRatio(text: string): number {
  if (!text) return 0;
  // Split into sentences
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 3);
  if (sentences.length === 0) return 0;

  const questions = text.split("?").length - 1;
  const total = sentences.length;
  return Math.round((questions / total) * 100);
}

function computePronounOwnership(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  // Ownership pronouns (I/we language)
  const ownershipWords = new Set(["i", "i'm", "i've", "i'll", "i'd", "my", "mine", "myself", "we", "we're", "we've", "we'll", "our", "ours", "ourselves"]);
  // Distancing pronouns (they/them language)
  const distancingWords = new Set(["they", "they're", "they've", "they'll", "them", "their", "theirs", "themselves", "the team", "the group", "management", "leadership"]);

  let ownership = 0;
  let distancing = 0;

  for (const word of words) {
    if (ownershipWords.has(word)) ownership++;
    if (distancingWords.has(word)) distancing++;
  }

  // Check for "the team" bigram
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === "the" && (words[i + 1] === "team" || words[i + 1] === "group")) {
      distancing++;
    }
  }

  const total = ownership + distancing;
  if (total === 0) return 0.5; // Neutral

  // Return 0-1 where 1 = all ownership, 0 = all distancing
  return +(ownership / total).toFixed(2);
}

function computeLexicalDiversity(text: string): number {
  if (!text) return 0;
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;

  const unique = new Set(words);
  // Corrected type-token ratio (root TTR) to normalize for text length
  return +(unique.size / Math.sqrt(words.length)).toFixed(3);
}

async function computeTopicSimilarities(
  clientId: string,
  limit: number
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  try {
    // Get consecutive session pairs with embeddings
    const rows = await prisma.$queryRawUnsafe<
      Array<{ session_id: string; similarity: number }>
    >(`
      WITH ordered_sessions AS (
        SELECT
          s.id as session_id,
          t.embedding,
          ROW_NUMBER() OVER (ORDER BY s.date ASC) as rn
        FROM sessions s
        JOIN transcripts t ON t."sessionId" = s.id
        WHERE s."clientId" = $1
          AND t.embedding IS NOT NULL
        ORDER BY s.date ASC
        LIMIT $2
      )
      SELECT
        curr.session_id,
        1 - (curr.embedding <=> prev.embedding) as similarity
      FROM ordered_sessions curr
      JOIN ordered_sessions prev ON prev.rn = curr.rn - 1
    `, clientId, limit);

    for (const row of rows) {
      result.set(row.session_id, Number(row.similarity));
    }
  } catch {
    // Embeddings may not exist — return empty map
  }

  return result;
}
