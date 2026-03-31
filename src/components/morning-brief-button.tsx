"use client";

import { useState } from "react";

export function MorningBriefButton() {
  const [brief, setBrief] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleGenerate() {
    if (brief && !loading) {
      setExpanded(!expanded);
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch("/api/daily-brief");
      const data = await resp.json();
      if (data.brief) {
        setBrief(data.brief);
        setExpanded(true);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleGenerate}
        disabled={loading}
        className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
      >
        {loading
          ? "Generating..."
          : brief
            ? expanded
              ? "Hide Morning Brief"
              : "Show Morning Brief"
            : "Generate Morning Brief"}
      </button>

      {expanded && brief && (
        <div className="mt-4 bg-surface border border-border border-l-3 border-l-accent rounded-r-[var(--radius-md)] p-5">
          <div className="prose prose-sm max-w-none text-foreground text-sm leading-relaxed whitespace-pre-line [&_strong]:font-semibold [&_strong]:text-foreground">
            {brief}
          </div>
        </div>
      )}
    </div>
  );
}
