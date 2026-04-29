"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface WordData {
  text: string;
  count: number;
  weight: number;
}

interface WordContextMatch {
  sessionId: string;
  clientId: string;
  clientName: string;
  date: string;
  title: string;
  snippet: string;
}

interface WordContextResponse {
  word: string;
  source: "synopsis" | "transcript";
  total: number;
  matches: WordContextMatch[];
}

interface ClientOption {
  id: string;
  name: string;
}

export function WordCloudSection() {
  const [words, setWords] = useState<WordData[]>([]);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [source, setSource] = useState<"synopsis" | "transcript">("synopsis");
  const [totalTexts, setTotalTexts] = useState(0);
  const [hoveredWord, setHoveredWord] = useState<WordData | null>(null);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [context, setContext] = useState<WordContextResponse | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  // Load client list
  useEffect(() => {
    fetch("/api/analytics")
      .then((r) => r.json())
      .then((data) => {
        if (data.topClientsData) {
          setClients(
            data.topClientsData.map((c: { fullName: string; name: string }) => ({
              id: c.name, // The analytics API returns short names; we need IDs
              name: c.fullName,
            }))
          );
        }
      })
      .catch(() => {});

    // Also fetch actual client list for IDs
    fetch("/api/clients-list")
      .then((r) => r.json())
      .then((data) => {
        if (data.clients) setClients(data.clients);
      })
      .catch(() => {});
  }, []);

  const fetchWordCloud = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ source, maxWords: "80" });
      if (selectedClient) params.set("clientId", selectedClient);
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const resp = await fetch(`/api/analytics/word-cloud?${params}`);
      const data = await resp.json();
      setWords(data.words || []);
      setTotalTexts(data.totalTexts || 0);
    } catch {
      setWords([]);
    } finally {
      setLoading(false);
    }
  }, [selectedClient, startDate, endDate, source]);

  useEffect(() => { fetchWordCloud(); }, [fetchWordCloud]);

  const fetchWordContext = useCallback(
    async (word: string) => {
      setContextLoading(true);
      setContextError(null);
      try {
        const params = new URLSearchParams({ word, source });
        if (selectedClient) params.set("clientId", selectedClient);
        if (startDate) params.set("startDate", startDate);
        if (endDate) params.set("endDate", endDate);
        const resp = await fetch(`/api/analytics/word-context?${params}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
        setContext(data as WordContextResponse);
      } catch (err) {
        setContextError(err instanceof Error ? err.message : "Failed to load");
        setContext(null);
      } finally {
        setContextLoading(false);
      }
    },
    [source, selectedClient, startDate, endDate]
  );

  const handleWordClick = useCallback(
    (word: WordData) => {
      setSelectedWord(word.text);
      void fetchWordContext(word.text);
    },
    [fetchWordContext]
  );

  // If the user changes the source/client/date filters while a word is
  // selected, re-fetch context against the new scope.
  useEffect(() => {
    if (selectedWord) void fetchWordContext(selectedWord);
    // We intentionally only react to scope changes, not selectedWord changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, selectedClient, startDate, endDate]);

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h2 className="font-display text-lg text-foreground">Word Cloud</h2>
          <p className="text-xs text-muted mt-0.5">
            Most frequent themes across {totalTexts} {source === "synopsis" ? "session synopses" : "transcripts"}
          </p>
        </div>

        {/* Source toggle */}
        <div className="flex border border-border rounded overflow-hidden">
          <button
            onClick={() => setSource("synopsis")}
            className={`px-3 py-1 text-xs font-medium transition-colors ${source === "synopsis" ? "bg-foreground text-background" : "bg-surface text-muted hover:text-foreground"}`}
          >
            Synopses
          </button>
          <button
            onClick={() => setSource("transcript")}
            className={`px-3 py-1 text-xs font-medium transition-colors ${source === "transcript" ? "bg-foreground text-background" : "bg-surface text-muted hover:text-foreground"}`}
          >
            Transcripts
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <select
          value={selectedClient}
          onChange={(e) => setSelectedClient(e.target.value)}
          className="bg-background border border-border rounded px-3 py-1.5 text-xs outline-none focus:border-accent"
        >
          <option value="">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="bg-background border border-border rounded px-3 py-1.5 text-xs font-mono outline-none focus:border-accent"
          placeholder="Start date"
        />
        <span className="text-xs text-muted">to</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="bg-background border border-border rounded px-3 py-1.5 text-xs font-mono outline-none focus:border-accent"
          placeholder="End date"
        />

        {(selectedClient || startDate || endDate) && (
          <button
            onClick={() => { setSelectedClient(""); setStartDate(""); setEndDate(""); }}
            className="text-xs text-accent hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Word cloud visualization */}
      {loading ? (
        <div className="h-[320px] bg-border/20 rounded animate-pulse" />
      ) : words.length === 0 ? (
        <div className="h-[320px] flex items-center justify-center text-sm text-muted">
          No data available for the selected filters.
        </div>
      ) : (
        <div className="relative">
          <WordCloudSVG
            words={words}
            hoveredWord={hoveredWord}
            selectedWord={selectedWord}
            onHover={setHoveredWord}
            onClick={handleWordClick}
          />
          {hoveredWord && (
            <div className="absolute top-2 right-2 bg-foreground text-background px-3 py-1.5 rounded text-xs font-mono shadow-lg">
              &ldquo;{hoveredWord.text}&rdquo; — {hoveredWord.count} occurrences
            </div>
          )}
        </div>
      )}

      {/* Click-through context panel */}
      {selectedWord && (
        <WordContextPanel
          word={selectedWord}
          source={source}
          loading={contextLoading}
          error={contextError}
          context={context}
          onClose={() => {
            setSelectedWord(null);
            setContext(null);
            setContextError(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Context panel (rendered below the cloud on click) ────────────

function WordContextPanel({
  word,
  source,
  loading,
  error,
  context,
  onClose,
}: {
  word: string;
  source: "synopsis" | "transcript";
  loading: boolean;
  error: string | null;
  context: WordContextResponse | null;
  onClose: () => void;
}) {
  const matches = context?.matches ?? [];

  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h3 className="font-display text-base text-foreground">
            &ldquo;{word}&rdquo;
            {!loading && context && (
              <span className="text-muted text-sm font-body ml-2">
                — {context.total}{" "}
                {context.total === 1 ? "match" : "matches"} in{" "}
                {source === "synopsis" ? "synopses" : "transcripts"}
              </span>
            )}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-accent hover:underline"
          aria-label="Close context panel"
        >
          Close
        </button>
      </div>

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 bg-border/30 rounded animate-pulse" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="text-sm text-error font-mono break-words">{error}</div>
      )}

      {!loading && !error && matches.length === 0 && (
        <div className="text-sm text-muted">
          No matches under the current filters.
        </div>
      )}

      {!loading && !error && matches.length > 0 && (
        <ul className="space-y-3">
          {matches.map((m) => (
            <li
              key={m.sessionId}
              className="border-l border-border pl-4 py-1"
            >
              <Link
                href={`/clients/${m.clientId}#session-${m.sessionId}`}
                className="block group"
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-muted tabular-nums shrink-0">
                    {new Date(m.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                  <span className="font-display text-sm text-foreground group-hover:text-accent transition-colors truncate">
                    {m.clientName}
                  </span>
                </div>
                <p
                  className="mt-1 text-sm text-foreground/80 leading-relaxed [&_mark]:bg-[var(--accent-light,#FEF3C7)] [&_mark]:text-foreground [&_mark]:px-0.5 [&_mark]:rounded"
                  dangerouslySetInnerHTML={{ __html: m.snippet }}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── SVG Word Cloud ───────────────────────────────────────

function WordCloudSVG({
  words,
  hoveredWord,
  selectedWord,
  onHover,
  onClick,
}: {
  words: WordData[];
  hoveredWord: WordData | null;
  selectedWord: string | null;
  onHover: (w: WordData | null) => void;
  onClick: (w: WordData) => void;
}) {
  const width = 800;
  const height = 320;

  // Simple spiral layout
  const positions = computePositions(words, width, height);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[320px]">
      {positions.map((pos, i) => {
        const word = words[i];
        const isHovered = hoveredWord?.text === word.text;
        const isSelected = selectedWord === word.text;
        const fontSize = Math.max(11, Math.min(48, 11 + word.weight * 37));
        const opacity = word.weight * 0.7 + 0.3;

        // Color based on weight: accent for high, muted for low
        const color = word.weight > 0.5
          ? "var(--accent)"
          : word.weight > 0.2
            ? "var(--foreground)"
            : "var(--muted)";

        const active = isHovered || isSelected;

        return (
          <text
            key={word.text}
            x={pos.x}
            y={pos.y}
            fontSize={fontSize}
            fill={active ? "var(--accent)" : color}
            opacity={active ? 1 : opacity}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="var(--font-body, 'DM Sans', sans-serif)"
            fontWeight={isSelected || word.weight > 0.4 ? 600 : 400}
            className="transition-all duration-150 cursor-pointer select-none"
            style={{
              transform: active ? "scale(1.1)" : "scale(1)",
              transformOrigin: `${pos.x}px ${pos.y}px`,
              textDecoration: isSelected ? "underline" : undefined,
              textUnderlineOffset: "0.2em",
            }}
            onMouseEnter={() => onHover(word)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onClick(word)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick(word);
              }
            }}
          >
            {word.text}
          </text>
        );
      })}
    </svg>
  );
}

function computePositions(
  words: WordData[],
  width: number,
  height: number
): Array<{ x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const positions: Array<{ x: number; y: number }> = [];

  // Archimedean spiral placement
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const fontSize = Math.max(11, Math.min(48, 11 + word.weight * 37));
    const estimatedWidth = word.text.length * fontSize * 0.55;
    const estimatedHeight = fontSize * 1.3;

    let x = cx;
    let y = cy;
    let placed_ok = false;

    // Spiral outward from center
    for (let t = 0; t < 1000; t += 0.3) {
      const radius = t * 2.5;
      const angle = t;
      x = cx + radius * Math.cos(angle);
      y = cy + radius * Math.sin(angle) * 0.6; // Compress vertically

      // Check bounds
      if (
        x - estimatedWidth / 2 < 10 ||
        x + estimatedWidth / 2 > width - 10 ||
        y - estimatedHeight / 2 < 10 ||
        y + estimatedHeight / 2 > height - 10
      ) continue;

      // Check overlaps
      const overlap = placed.some((p) =>
        Math.abs(x - p.x) < (estimatedWidth + p.w) / 2 + 4 &&
        Math.abs(y - p.y) < (estimatedHeight + p.h) / 2 + 2
      );

      if (!overlap) {
        placed_ok = true;
        break;
      }
    }

    if (!placed_ok) {
      // Place off-screen if can't fit (won't render visibly)
      x = -999;
      y = -999;
    }

    positions.push({ x, y });
    placed.push({ x, y, w: estimatedWidth, h: estimatedHeight });
  }

  return positions;
}
