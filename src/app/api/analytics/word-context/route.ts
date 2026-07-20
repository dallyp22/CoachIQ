import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  requireCoach,
  scopeCoachId,
  viaClientWhere,
  authzResponse,
} from "@/lib/authz";

/**
 * GET /api/analytics/word-context — for a given word in the word cloud,
 * return every session that contains it with a context snippet.
 *
 * Query params:
 *   word        (required) — the literal word the user clicked
 *   source      synopsis|transcript (default: synopsis)
 *   clientId    optional UUID to scope to a single client
 *   startDate   YYYY-MM-DD inclusive
 *   endDate     YYYY-MM-DD inclusive
 *
 * For transcripts: uses Postgres ts_headline (so we get stemming + word
 * boundaries) and returns highlighted HTML fragments.
 * For synopses: matches on \bword\b with case-insensitive regex in JS, then
 * extracts the surrounding sentence and wraps the match in <mark>.
 *
 * Snippet HTML uses only <mark> tags and is rendered with a constrained
 * dangerouslySetInnerHTML on the client.
 */

interface Match {
  sessionId: string;
  clientId: string;
  clientName: string;
  date: string;
  title: string;
  snippet: string; // HTML — only <mark> tags allowed
}

export async function GET(request: NextRequest) {
  let coachId: string | null;
  try {
    const coach = await requireCoach();
    coachId = scopeCoachId(coach, request.nextUrl.searchParams.get("coachId"));
  } catch (err) {
    return authzResponse(err);
  }

  try {
    const url = new URL(request.url);
    const word = (url.searchParams.get("word") ?? "").trim();
    const source =
      url.searchParams.get("source") === "transcript" ? "transcript" : "synopsis";
    const clientId = url.searchParams.get("clientId") || null;
    const startDate = url.searchParams.get("startDate") || null;
    const endDate = url.searchParams.get("endDate") || null;

    if (!word) {
      return NextResponse.json(
        { error: "word query param is required" },
        { status: 400 }
      );
    }
    // Defensive cap on word length and characters to prevent absurd inputs.
    if (word.length > 60 || /[<>]/.test(word)) {
      return NextResponse.json({ error: "invalid word" }, { status: 400 });
    }

    const matches =
      source === "transcript"
        ? await transcriptMatches(word, clientId, startDate, endDate, coachId)
        : await synopsisMatches(word, clientId, startDate, endDate, coachId);

    return NextResponse.json({
      word,
      source,
      total: matches.length,
      matches,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[word-context] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── Transcript matches via ts_headline ─────────────────────────

async function transcriptMatches(
  word: string,
  clientId: string | null,
  startDate: string | null,
  endDate: string | null,
  coachId: string | null
): Promise<Match[]> {
  const params: unknown[] = [word];
  const filters: string[] = [];

  if (coachId) {
    params.push(coachId);
    filters.push(`c."coachId" = $${params.length}::uuid`);
  }
  if (clientId) {
    params.push(clientId);
    filters.push(`s."clientId" = $${params.length}::uuid`);
  }
  if (startDate) {
    params.push(`${startDate}T00:00:00Z`);
    filters.push(`s.date >= $${params.length}::timestamptz`);
  }
  if (endDate) {
    params.push(`${endDate}T23:59:59Z`);
    filters.push(`s.date <= $${params.length}::timestamptz`);
  }

  const filterSql = filters.length ? `AND ${filters.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      session_id: string;
      client_id: string;
      client_name: string;
      date: Date;
      title: string;
      snippet: string;
    }>
  >(
    `
    SELECT
      s.id          AS session_id,
      c.id          AS client_id,
      c.name        AS client_name,
      s.date,
      s.title,
      ts_headline(
        'english',
        t."fullText",
        plainto_tsquery('english', $1),
        'MaxFragments=2,MaxWords=24,MinWords=10,StartSel=⟦MARK⟧,StopSel=⟦/MARK⟧,FragmentDelimiter= … '
      ) AS snippet
    FROM transcripts t
    JOIN sessions s ON t."sessionId" = s.id
    JOIN clients c ON t."clientId" = c.id
    WHERE t.search_text @@ plainto_tsquery('english', $1)
    ${filterSql}
    ORDER BY s.date DESC
    LIMIT 50
    `,
    ...params
  );

  return rows.map((r) => ({
    sessionId: r.session_id,
    clientId: r.client_id,
    clientName: r.client_name,
    date: new Date(r.date).toISOString(),
    title: r.title,
    // Escape any HTML in the underlying transcript, then swap the placeholder
    // tokens back to <mark>/</mark>. This keeps user content safe even when
    // a transcript contains literal angle brackets.
    snippet: escapeHtml(r.snippet)
      .replace(/⟦MARK⟧/g, "<mark>")
      .replace(/⟦\/MARK⟧/g, "</mark>"),
  }));
}

// ─── Synopsis matches via JS regex extraction ───────────────────

async function synopsisMatches(
  word: string,
  clientId: string | null,
  startDate: string | null,
  endDate: string | null,
  coachId: string | null
): Promise<Match[]> {
  // Pull candidate sessions cheaply via ILIKE first, then do precise word-
  // boundary matching + sentence extraction in JS. ILIKE keeps the result
  // set small (one client typically has <50 synopses).
  const filters: { synopsis: { not: null } } & Record<string, unknown> = {
    synopsis: { not: null },
  };
  if (clientId) filters.clientId = clientId;
  if (startDate || endDate) {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (startDate) dateFilter.gte = new Date(`${startDate}T00:00:00Z`);
    if (endDate) dateFilter.lte = new Date(`${endDate}T23:59:59Z`);
    (filters as Record<string, unknown>).date = dateFilter;
  }

  const rows = await prisma.session.findMany({
    where: {
      ...(filters as object),
      synopsis: {
        not: null,
        contains: word,
        mode: "insensitive",
      },
      ...viaClientWhere(coachId),
    },
    orderBy: { date: "desc" },
    take: 50,
    select: {
      id: true,
      clientId: true,
      date: true,
      title: true,
      synopsis: true,
      client: { select: { name: true } },
    },
  });

  const wordRe = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
  const out: Match[] = [];
  for (const r of rows) {
    if (!r.synopsis) continue;
    const snippet = extractSentenceSnippet(r.synopsis, word, wordRe);
    if (!snippet) continue; // ILIKE matched a substring but \b\w+\b didn't
    out.push({
      sessionId: r.id,
      clientId: r.clientId,
      clientName: r.client.name,
      date: r.date.toISOString(),
      title: r.title,
      snippet,
    });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Find the sentence(s) containing the word, return up to 2 with the matches
 * highlighted. We split on common sentence-final punctuation followed by
 * whitespace.
 */
function extractSentenceSnippet(
  synopsis: string,
  word: string,
  wordRe: RegExp
): string | null {
  const sentences = synopsis.split(/(?<=[.!?])\s+/);
  const hits: string[] = [];
  for (const sent of sentences) {
    if (wordRe.test(sent)) {
      hits.push(sent.trim());
      if (hits.length === 2) break;
    }
  }
  if (hits.length === 0) return null;

  const highlighter = new RegExp(`\\b(${escapeRegex(word)})\\b`, "gi");
  return hits
    .map((s) => escapeHtml(s).replace(highlighter, "<mark>$1</mark>"))
    .join(" … ");
}
