"use client";

import { useState } from "react";
import Link from "next/link";

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

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [method, setMethod] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);

    try {
      const resp = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), limit: 15 }),
      });
      const data = await resp.json();
      setResults(data.results || []);
      setMethod(data.method);
    } catch {
      setResults([]);
      setMethod("error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {/* Search Hero */}
      <div className="text-center py-6">
        <h1 className="font-display text-[28px] text-foreground">
          What are you looking for?
        </h1>

        <form onSubmit={handleSearch} className="mt-6 max-w-[640px] mx-auto">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all coaching sessions..."
            className="w-full px-5 py-3.5 font-mono text-sm border-2 border-border rounded-[var(--radius-md)] bg-background text-foreground outline-none transition-colors focus:border-accent placeholder:text-muted"
          />
        </form>

        {method === "fulltext" && searched && (
          <p className="text-xs text-muted mt-3">
            Using keyword search (semantic search requires transcript embeddings)
          </p>
        )}
        {method === "error" && (
          <p className="text-xs text-error mt-3">
            Search temporarily unavailable. Try again.
          </p>
        )}
      </div>

      {/* Results */}
      <div className="mt-6">
        {loading && (
          <div className="text-center py-12">
            <p className="text-sm text-muted animate-pulse">
              Searching transcripts...
            </p>
          </div>
        )}

        {!loading && searched && results.length === 0 && (
          <div className="text-center py-12">
            <p className="font-display text-lg text-foreground">
              Nothing matches that query
            </p>
            <p className="text-sm text-muted mt-2">
              Try different words or broaden your search.
            </p>
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="space-y-3">
            {results.map((result) => (
              <div
                key={result.sessionId}
                className="bg-surface border border-border rounded-[var(--radius-md)] p-5"
              >
                <div className="flex justify-between items-start mb-2">
                  <Link
                    href={`/clients/${result.clientId}`}
                    className="text-sm font-semibold text-foreground hover:text-accent transition-colors"
                  >
                    {result.clientName}
                    <span className="font-normal text-muted">
                      {" "}
                      — {result.title}
                    </span>
                  </Link>
                  <span className="font-mono text-xs text-muted shrink-0 ml-4">
                    {new Date(result.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>

                <p
                  className="text-sm text-muted leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: result.excerpt }}
                />

                {result.recordingUrl && (
                  <a
                    href={result.recordingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-3 text-xs text-accent hover:underline"
                  >
                    View Recording
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
