"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Add to the thread. A coach signs their own name. The owner (canPostAsTeam)
 * can reply as "CoachIQ Team" — the product speaking — which is the default,
 * since triage replies are the product's voice, not a personal one.
 */
export function CommentForm({ id, canPostAsTeam }: { id: string; canPostAsTeam: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [asTeam, setAsTeam] = useState(canPostAsTeam);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await fetch(`/api/feedback/${id}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, asTeam: canPostAsTeam ? asTeam : undefined }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setErr(data.error || "Could not post.");
        return;
      }
      setBody("");
      router.refresh();
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <textarea
        className="min-h-[56px] w-full resize-y rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={canPostAsTeam ? "Reply to the reporter…" : "Add a note…"}
        maxLength={5000}
      />
      <div className="flex items-center justify-between gap-3">
        {canPostAsTeam ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={asTeam} onChange={(e) => setAsTeam(e.target.checked)} />
            Reply as CoachIQ Team
          </label>
        ) : (
          <span />
        )}
        <button
          type="submit"
          disabled={busy || !body.trim()}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
      {err && <p className="text-sm text-error">{err}</p>}
    </form>
  );
}
