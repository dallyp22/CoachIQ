import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const OPENAI_API_KEY = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY || "";

interface SearchResult {
  sessionId: string;
  clientName: string;
  clientId: string;
  title: string;
  date: string;
  excerpt: string;
  recordingUrl: string | null;
  score: number;
}

/**
 * Semantic search pipeline:
 *   1. Embed query via OpenAI text-embedding-3-small
 *   2. pgvector cosine similarity search across transcripts
 *   3. Fallback to tsvector full-text search if embedding fails
 *   4. Return ranked results with excerpts
 */
export async function POST(request: NextRequest) {
  const { query, clientId, limit = 10 } = await request.json();

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return NextResponse.json({ results: [], method: "none" });
  }

  // Try semantic search first, fall back to full-text
  let results: SearchResult[];
  let method: string;

  try {
    const embedding = await generateEmbedding(query);
    results = await semanticSearch(embedding, clientId, limit);
    method = "semantic";
  } catch {
    // Fallback to full-text search
    results = await fullTextSearch(query, clientId, limit);
    method = "fulltext";
  }

  return NextResponse.json({ results, method });
}

async function generateEmbedding(text: string): Promise<number[]> {
  if (!OPENAI_API_KEY) {
    throw new Error("No OpenAI API key configured");
  }

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API error: ${resp.status}`);
  }

  const data = await resp.json();
  return data.data[0].embedding;
}

async function semanticSearch(
  embedding: number[],
  clientId: string | undefined,
  limit: number
): Promise<SearchResult[]> {
  const embeddingStr = `[${embedding.join(",")}]`;

  const clientFilter = clientId
    ? `AND t."clientId" = '${clientId}'`
    : "";

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      session_id: string;
      client_name: string;
      client_id: string;
      title: string;
      date: Date;
      excerpt: string;
      recording_url: string | null;
      score: number;
    }>
  >(`
    SELECT
      s.id as session_id,
      c.name as client_name,
      c.id as client_id,
      s.title,
      s.date,
      LEFT(t."fullText", 500) as excerpt,
      s."recordingUrl" as recording_url,
      1 - (t.embedding <=> '${embeddingStr}'::vector) as score
    FROM transcripts t
    JOIN sessions s ON t."sessionId" = s.id
    JOIN clients c ON t."clientId" = c.id
    WHERE t.embedding IS NOT NULL
    ${clientFilter}
    ORDER BY t.embedding <=> '${embeddingStr}'::vector
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    sessionId: r.session_id,
    clientName: r.client_name,
    clientId: r.client_id,
    title: r.title,
    date: new Date(r.date).toISOString(),
    excerpt: r.excerpt,
    recordingUrl: r.recording_url,
    score: Number(r.score),
  }));
}

async function fullTextSearch(
  query: string,
  clientId: string | undefined,
  limit: number
): Promise<SearchResult[]> {
  // Convert natural language query to tsquery
  const tsquery = query
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" & ");

  if (!tsquery) return [];

  const clientFilter = clientId
    ? `AND t."clientId" = '${clientId}'`
    : "";

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      session_id: string;
      client_name: string;
      client_id: string;
      title: string;
      date: Date;
      excerpt: string;
      recording_url: string | null;
      score: number;
    }>
  >(`
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
    ${clientFilter}
    ORDER BY score DESC
    LIMIT ${limit}
  `, query);

  return rows.map((r) => ({
    sessionId: r.session_id,
    clientName: r.client_name,
    clientId: r.client_id,
    title: r.title,
    date: new Date(r.date).toISOString(),
    excerpt: r.excerpt,
    recordingUrl: r.recording_url,
    score: Number(r.score),
  }));
}
