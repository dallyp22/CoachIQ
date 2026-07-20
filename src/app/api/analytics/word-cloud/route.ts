import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  requireCoach,
  scopeCoachId,
  clientWhere,
  viaClientWhere,
  authzResponse,
} from "@/lib/authz";

// Comprehensive stop words: standard English + contractions + filler + coaching noise
const STOP_WORDS = new Set([
  // Standard English stops
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
  "still", "here", "more", "where", "those", "down", "keep", "part",
  "need", "work", "first", "last", "able", "feel", "start", "tell",
  "mean", "hear", "kind", "point", "through", "already", "better",
  "different", "every", "many", "same", "such", "before", "between",
  "each", "find", "long", "must", "should", "since", "while", "show",
  "always", "never", "around", "help", "put", "call", "place",
  "again", "away", "end", "off", "own", "run", "set", "turn",
  "high", "left", "next", "old", "open", "move", "live", "might",
  "under", "world", "enough", "quite", "three", "four", "five",

  // Contractions (with and without apostrophe)
  "it's", "its", "i'm", "i've", "i'll", "i'd",
  "don't", "dont", "didn't", "didnt", "doesn't", "doesnt",
  "can't", "cant", "couldn't", "couldnt", "wouldn't", "wouldnt",
  "shouldn't", "shouldnt", "won't", "wont", "isn't", "isnt",
  "aren't", "arent", "wasn't", "wasnt", "weren't", "werent",
  "hasn't", "hasnt", "haven't", "havent", "hadn't", "hadnt",
  "that's", "thats", "there's", "theres", "here's", "heres",
  "what's", "whats", "who's", "whos", "where's", "wheres",
  "he's", "hes", "she's", "shes", "it'll", "we'll", "well",
  "you're", "youre", "they're", "theyre", "we're", "were",
  "you've", "youve", "they've", "theyve", "we've", "weve",
  "you'll", "youll", "they'll", "theyll",
  "you'd", "youd", "they'd", "theyd", "we'd", "wed",
  "let's", "lets",

  // Filler / conversational noise
  "yeah", "yes", "okay", "ok", "um", "uh", "ah", "oh", "hmm", "huh",
  "gonna", "gotta", "wanna", "kinda", "sorta", "maybe", "actually",
  "basically", "literally", "definitely", "probably", "absolutely",
  "completely", "totally", "certainly", "exactly", "especially",
  "apparently", "obviously", "clearly", "honestly", "seriously",
  "sorry", "please", "thank", "thanks", "sure", "stuff", "whatever",
  "anyway", "alright", "cool", "great", "nice", "fine", "sounds",

  // Coaching/transcript noise
  "coaching", "session", "transcript", "recording", "client",
  "todd", "zimbelman", "action", "items", "summary", "full",
  "executive", "unknown", "date", "title", "fathom", "video",
  "share", "https", "http", "www", "com", "gmail", "email",
  "minute", "minutes", "hour", "hours", "week", "weeks",
  "month", "months", "today", "tomorrow", "yesterday",
  "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "january", "february", "march",
  "april", "may", "june", "july", "august", "september",
  "october", "november", "december",
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
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

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

    // Dynamically build stop words from client + coach names
    const dynamicStops = new Set(STOP_WORDS);

    const allClients = await prisma.client.findMany({
      where: clientWhere(coachId),
      select: { name: true },
    });
    for (const c of allClients) {
      for (const part of c.name.toLowerCase().split(/\s+/)) {
        if (part.length > 1) dynamicStops.add(part);
      }
    }
    // Also add coach name parts
    const settings = await prisma.coachSettings.findFirst({ select: { coachName: true } });
    if (settings?.coachName) {
      for (const part of settings.coachName.toLowerCase().split(/\s+/)) {
        if (part.length > 1) dynamicStops.add(part);
      }
    }

    let texts: string[] = [];

    if (source === "synopsis") {
      const sessions = await prisma.session.findMany({
        where: { ...where, synopsis: { not: null }, ...viaClientWhere(coachId) },
        select: { synopsis: true },
      });
      texts = sessions.map((s) => s.synopsis!);
    } else {
      const transcripts = await prisma.transcript.findMany({
        where: {
          ...(clientId ? { clientId } : {}),
          session: Object.keys(dateFilter).length > 0 ? { date: dateFilter } : undefined,
          ...viaClientWhere(coachId),
        },
        select: { fullText: true },
      });
      texts = transcripts.map((t) => t.fullText);
    }

    if (texts.length === 0) {
      return NextResponse.json({ words: [], totalTexts: 0 });
    }

    // Clean text: strip URLs, timestamps, speaker labels, contractions
    function cleanText(text: string): string {
      return text
        .replace(/https?:\/\/\S+/g, " ")           // URLs
        .replace(/\[[\d:]+\]/g, " ")                // timestamps [00:12:34]
        .replace(/^.*?:\s/gm, " ")                  // speaker labels "Name: "
        .replace(/---.*?---/g, " ")                  // section headers
        .replace(/COACHING SESSION TRANSCRIPT/g, " ") // header
        .replace(/['']/g, "'")                       // normalize smart quotes
        .replace(/n't/g, " not")                     // expand contractions
        .replace(/'s\b/g, " ")                       // remove possessives
        .replace(/'re\b/g, " are")
        .replace(/'ve\b/g, " have")
        .replace(/'ll\b/g, " will")
        .replace(/'m\b/g, " am")
        .replace(/'d\b/g, " would")
        .toLowerCase()
        .replace(/[^a-z\s-]/g, " ")                 // only letters, spaces, hyphens
        .replace(/\b[a-z]{1,3}\b/g, " ")            // remove 1-3 letter words
        .replace(/\s+/g, " ")
        .trim();
    }

    function isValidWord(word: string): boolean {
      if (word.length < 4) return false;
      if (dynamicStops.has(word)) return false;
      if (/^\d+$/.test(word)) return false;
      if (/^(.)\1+$/.test(word)) return false;   // repeated chars like "aaaa"
      if (word.includes("--")) return false;
      return true;
    }

    // Extract single-word frequencies
    const freq = new Map<string, number>();
    for (const text of texts) {
      const cleaned = cleanText(text);
      const words = cleaned.split(/\s+/).filter(isValidWord);
      for (const word of words) {
        freq.set(word, (freq.get(word) || 0) + 1);
      }
    }

    // Extract meaningful bigrams
    for (const text of texts) {
      const cleaned = cleanText(text);
      const words = cleaned.split(/\s+/).filter(isValidWord);
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `${words[i]} ${words[i + 1]}`;
        // Only keep bigrams where both words are meaningful
        if (words[i].length >= 4 && words[i + 1].length >= 4) {
          freq.set(bigram, (freq.get(bigram) || 0) + 1);
        }
      }
    }

    // Filter: minimum occurrences scale with corpus size
    const minCount = texts.length <= 5 ? 2 : texts.length <= 50 ? 3 : 4;

    const sorted = [...freq.entries()]
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxWords);

    const maxFreq = sorted.length > 0 ? sorted[0][1] : 1;

    const words = sorted.map(([text, count]) => ({
      text,
      count,
      weight: count / maxFreq,
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
