import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Common English stop words + coaching-specific noise words
const STOP_WORDS = new Set([
  // Standard stops
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for",
  "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his",
  "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my",
  "one", "all", "would", "there", "their", "what", "so", "up", "out", "if",
  "about", "who", "get", "which", "go", "me", "when", "make", "can", "like",
  "time", "no", "just", "him", "know", "take", "people", "into", "year",
  "your", "good", "some", "could", "them", "see", "other", "than", "then",
  "now", "look", "only", "come", "its", "over", "think", "also", "back",
  "after", "use", "two", "how", "our", "way", "even", "new", "want",
  "because", "any", "these", "give", "day", "most", "us", "been", "has",
  "had", "was", "were", "did", "are", "is", "am", "does", "doing", "done",
  "being", "having", "got", "getting", "going", "went", "gone", "came",
  "coming", "made", "making", "said", "saying", "told", "telling",
  "thing", "things", "lot", "really", "very", "much", "well", "right",
  "yeah", "yes", "no", "okay", "ok", "um", "uh", "ah", "oh", "hmm",
  "gonna", "gotta", "wanna", "kinda", "sorta", "maybe", "actually",
  "basically", "literally", "definitely", "probably", "absolutely",
  // Coaching-specific noise
  "coaching", "session", "transcript", "recording", "client",
  "todd", "zimbelman", "action", "items", "summary", "full",
  "executive", "unknown", "date", "title",
]);

/**
 * GET /api/analytics/word-cloud — extract word frequencies from transcripts.
 *
 * Query params:
 *   clientId=UUID     — filter to a specific client
 *   startDate=YYYY-MM-DD — filter from date
 *   endDate=YYYY-MM-DD   — filter to date
 *   maxWords=100      — max words to return (default 80)
 *   source=transcript|synopsis — which text to analyze (default: synopsis)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const maxWords = Math.min(Number(searchParams.get("maxWords") || "80"), 200);
    const source = searchParams.get("source") || "synopsis";

    // Build where clause
    const where: Record<string, unknown> = {};
    if (clientId) where.clientId = clientId;
    const dateFilter: Record<string, Date> = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate + "T23:59:59");
    if (Object.keys(dateFilter).length > 0) where.date = dateFilter;

    let texts: string[] = [];

    if (source === "synopsis") {
      // Use session synopses (shorter, higher quality text)
      const sessions = await prisma.session.findMany({
        where: { ...where, synopsis: { not: null } },
        select: { synopsis: true },
      });
      texts = sessions.map((s) => s.synopsis!);
    } else {
      // Use full transcript text
      const transcripts = await prisma.transcript.findMany({
        where: {
          ...(clientId ? { clientId } : {}),
          session: Object.keys(dateFilter).length > 0 ? { date: dateFilter } : undefined,
        },
        select: { fullText: true },
      });
      texts = transcripts.map((t) => t.fullText);
    }

    if (texts.length === 0) {
      return NextResponse.json({ words: [], totalTexts: 0 });
    }

    // Extract word frequencies
    const freq = new Map<string, number>();
    for (const text of texts) {
      const words = text
        .toLowerCase()
        .replace(/[^a-z\s'-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

      for (const word of words) {
        freq.set(word, (freq.get(word) || 0) + 1);
      }
    }

    // Also extract bigrams (2-word phrases) for richer insights
    for (const text of texts) {
      const words = text
        .toLowerCase()
        .replace(/[^a-z\s'-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `${words[i]} ${words[i + 1]}`;
        if (bigram.length > 7) {
          freq.set(bigram, (freq.get(bigram) || 0) + 1);
        }
      }
    }

    // Sort by frequency, take top N
    const sorted = [...freq.entries()]
      .filter(([, count]) => count >= 2) // Minimum 2 occurrences
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxWords);

    const maxFreq = sorted.length > 0 ? sorted[0][1] : 1;

    const words = sorted.map(([text, count]) => ({
      text,
      count,
      weight: count / maxFreq, // 0-1 normalized
    }));

    return NextResponse.json({
      words,
      totalTexts: texts.length,
      source,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
