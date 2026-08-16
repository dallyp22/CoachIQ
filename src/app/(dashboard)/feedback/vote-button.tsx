"use client";

import { useState } from "react";

/**
 * Upvote toggle. Optimistic: the count flips on click and reverts if the
 * request fails, so it feels instant. Safe inside a card that's also a link —
 * it stops the click from navigating.
 */
export function VoteButton({
  id,
  voteCount,
  voted,
  size = "md",
}: {
  id: string;
  voteCount: number;
  voted: boolean;
  size?: "sm" | "md";
}) {
  const [state, setState] = useState({ count: voteCount, voted });
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);

    const next = { count: state.count + (state.voted ? -1 : 1), voted: !state.voted };
    setState(next);
    try {
      const resp = await fetch(`/api/feedback/${id}/vote`, { method: next.voted ? "POST" : "DELETE" });
      if (!resp.ok) {
        setState({ count: voteCount, voted }); // revert to server truth
        return;
      }
      const data = await resp.json();
      setState({ count: data.voteCount, voted: data.voted });
    } catch {
      setState({ count: voteCount, voted });
    } finally {
      setBusy(false);
    }
  }

  const sm = size === "sm";
  return (
    <button
      onClick={toggle}
      aria-pressed={state.voted}
      title={state.voted ? "Remove your vote" : "Upvote"}
      className={`inline-flex flex-none flex-col items-center justify-center rounded-md border transition-colors ${
        sm ? "w-9 py-0.5" : "w-11 py-1.5"
      } ${
        state.voted
          ? "border-accent bg-accent-light text-accent"
          : "border-border bg-surface text-muted hover:border-accent hover:text-accent"
      }`}
    >
      <svg className={sm ? "h-3 w-3" : "h-3.5 w-3.5"} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
      </svg>
      <span className={`font-mono font-semibold tabular-nums ${sm ? "text-[11px]" : "text-[13px]"}`}>{state.count}</span>
    </button>
  );
}
