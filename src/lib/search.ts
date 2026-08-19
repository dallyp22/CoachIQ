import { prisma } from "@/lib/db";
import { getOpenAIKey } from "@/lib/ai";

/**
 * The hybrid session-search pipeline, extracted from /api/search so both the
 * HTTP route and the MCP `search_sessions` tool share one implementation and
 * never drift. Coach scoping is the caller's job: pass the already-resolved
 * `coachId` (null = whole practice, for OWNER/ADMIN). This function NEVER widens
 * scope on its own — a null coachId here means the caller decided it was allowed.
 *
 * Pipeline:
 *   1. Client-name match (ILIKE) — always run.
 *   2. Content match — semantic (OpenAI embedding + pgvector), falling back to
 *      Postgres full-text (tsvector) when embeddings are unavailable.
 *   3. Merge: client matches first, then content matches, deduplicated.
 */

export interface SearchResult {
  sessionId: string;
  clientName: string;
  clientId: string;
  title: string;
  date: string;
  excerpt: string;
  recordingUrl: string | null;
  score: number;
}

export interface SearchSessionsInput {
  /** Already coach-scoped by the caller. null = whole practice. */
  coachId: string | null;
  query: string;
  /** Optional narrow to a single client. */
  clientId?: string;
  limit?: number;
}

export interface SearchSessionsResult {
  results: SearchResult[];
  method: "semantic" | "fulltext" | "client" | "none";
}

export async function searchSessions({
  coachId,
  query,
  clientId,
  limit = 15,
}: SearchSessionsInput): Promise<SearchSessionsResult> {
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return { results: [], method: "none" };
  }

  const safeLimit = Math.min(Math.max(1, Number(limit) || 15), 50);
  const trimmedQuery = query.trim();

  // 1. Client name search — always run
  const clientResults = await clientNameSearch(trimmedQuery, clientId, coachId, safeLimit);

  // 2. Content search — semantic with full-text fallback
  let contentResults: SearchResult[] = [];
  let method: SearchSessionsResult["method"] = "none";
  try {
    const apiKey = await getOpenAIKey();
    const embedding = await generateEmbedding(trimmedQuery, apiKey);
    contentResults = await semanticSearch(embedding, clientId, coachId, safeLimit);
    method = "semantic";
  } catch {
    contentResults = await fullTextSearch(trimmedQuery, clientId, coachId, safeLimit);
    method = contentResults.length > 0 ? "fulltext" : "client";
  }

  // 3. Merge: client matches first, then content matches, deduplicated
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const r of clientResults) {
    if (!seen.has(r.sessionId)) {
      seen.add(r.sessionId);
      results.push(r);
    }
  }
  for (const r of contentResults) {
    if (!seen.has(r.sessionId)) {
      seen.add(r.sessionId);
      results.push(r);
    }
  }

  if (clientResults.length > 0 && contentResults.length === 0) {
    method = "client";
  }

  return { results: results.slice(0, safeLimit), method };
}

// ─── Client Name Search ───────────────────────────────────

async function clientNameSearch(
  query: string,
  clientId: string | undefined,
  coachId: string | null,
  limit: number
): Promise<SearchResult[]> {
  const params: unknown[] = [`%${query}%`, limit];
  let filters = "";
  if (clientId) {
    params.push(clientId);
    filters += ` AND c.id = $${params.length}`;
  }
  if (coachId) {
    params.push(coachId);
    filters += ` AND c."coachId" = $${params.length}`;
  }

  const rows = await prisma.$queryRawUnsafe<Array<RawRow>>(
    `
    SELECT
      s.id as session_id,
      c.name as client_name,
      c.id as client_id,
      s.title,
      s.date,
      COALESCE(s.synopsis, LEFT(t."fullText", 300), s.title) as excerpt,
      s."recordingUrl" as recording_url,
      1.0 as score
    FROM sessions s
    JOIN clients c ON s."clientId" = c.id
    LEFT JOIN transcripts t ON t."sessionId" = s.id
    WHERE (c.name ILIKE $1 OR c.company ILIKE $1)
    ${filters}
    ORDER BY s.date DESC
    LIMIT $2
  `,
    ...params
  );

  return rows.map(mapRow);
}

// ─── Embedding Generation ─────────────────────────────────

async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });

  if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

// ─── Semantic Search (parameterized) ──────────────────────

async function semanticSearch(
  embedding: number[],
  clientId: string | undefined,
  coachId: string | null,
  limit: number
): Promise<SearchResult[]> {
  const embeddingStr = `[${embedding.join(",")}]`;
  const params: unknown[] = [embeddingStr, limit];
  let filters = "";
  if (clientId) {
    params.push(clientId);
    filters += ` AND t."clientId" = $${params.length}`;
  }
  if (coachId) {
    params.push(coachId);
    filters += ` AND c."coachId" = $${params.length}`;
  }

  const rows = await prisma.$queryRawUnsafe<Array<RawRow>>(
    `
    SELECT
      s.id as session_id,
      c.name as client_name,
      c.id as client_id,
      s.title,
      s.date,
      LEFT(t."fullText", 500) as excerpt,
      s."recordingUrl" as recording_url,
      1 - (t.embedding <=> $1::vector) as score
    FROM transcripts t
    JOIN sessions s ON t."sessionId" = s.id
    JOIN clients c ON t."clientId" = c.id
    WHERE t.embedding IS NOT NULL
    ${filters}
    ORDER BY t.embedding <=> $1::vector
    LIMIT $2
  `,
    ...params
  );

  return rows.map(mapRow);
}

// ─── Full-Text Search (parameterized) ─────────────────────

async function fullTextSearch(
  query: string,
  clientId: string | undefined,
  coachId: string | null,
  limit: number
): Promise<SearchResult[]> {
  const params: unknown[] = [query, limit];
  let filters = "";
  if (clientId) {
    params.push(clientId);
    filters += ` AND t."clientId" = $${params.length}`;
  }
  if (coachId) {
    params.push(coachId);
    filters += ` AND c."coachId" = $${params.length}`;
  }

  const rows = await prisma.$queryRawUnsafe<Array<RawRow>>(
    `
    SELECT
      s.id as session_id,
      c.name as client_name,
      c.id as client_id,
      s.title,
      s.date,
      ts_headline('english', t."fullText", plainto_tsquery('english', $1),
        'MaxFragments=2,MaxWords=60,MinWords=20,StartSel=<mark>,StopSel=</mark>'
      ) as excerpt,
      s."recordingUrl" as recording_url,
      ts_rank(t.search_text, plainto_tsquery('english', $1)) as score
    FROM transcripts t
    JOIN sessions s ON t."sessionId" = s.id
    JOIN clients c ON t."clientId" = c.id
    WHERE t.search_text @@ plainto_tsquery('english', $1)
    ${filters}
    ORDER BY score DESC
    LIMIT $2
  `,
    ...params
  );

  return rows.map(mapRow);
}

// ─── Shared row mapping ───────────────────────────────────

interface RawRow {
  session_id: string;
  client_name: string;
  client_id: string;
  title: string;
  date: Date;
  excerpt: string;
  recording_url: string | null;
  score: number;
}

function mapRow(r: RawRow): SearchResult {
  return {
    sessionId: r.session_id,
    clientName: r.client_name,
    clientId: r.client_id,
    title: r.title,
    date: new Date(r.date).toISOString(),
    excerpt: r.excerpt || "",
    recordingUrl: r.recording_url,
    score: Number(r.score),
  };
}
