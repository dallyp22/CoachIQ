"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FeedbackStage, FeedbackPriority } from "@/generated/prisma/enums";
import { ALL_STAGES, STAGE_LABELS, PRIORITY_LABELS } from "@/lib/feedback";

/**
 * Owner/admin triage bar, shown under each item. The one surface that moves an
 * item's stage, sets priority, or links a GitHub issue. Declining reveals a
 * required reason inline — the reporter reads it, so it can't be blank.
 */
export function TriageControls({
  id,
  stage,
  priority,
  githubUrl,
}: {
  id: string;
  stage: FeedbackStage;
  priority: FeedbackPriority | null;
  githubUrl: string | null;
}) {
  const router = useRouter();
  const [nextStage, setNextStage] = useState<FeedbackStage>(stage);
  const [note, setNote] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [github, setGithub] = useState(githubUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const resp = await fetch(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setErr(data.error || "Update failed.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setErr("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyStage() {
    if (nextStage === stage && !note.trim()) return;
    const ok = await patch({
      stage: nextStage,
      note: note.trim() || undefined,
      declineReason: nextStage === "DECLINED" ? declineReason.trim() : undefined,
    });
    if (ok) {
      setNote("");
      setDeclineReason("");
    }
  }

  // A note annotates a stage move; it isn't a standalone update (freeform goes
  // through the comment thread). So Apply only lights up on an actual move.
  const stageDirty = nextStage !== stage;

  return (
    <div className="mt-4 rounded-[var(--radius-lg)] border border-dashed border-border bg-background/60 p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Triage</p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted">Stage</span>
          <select
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            value={nextStage}
            onChange={(e) => setNextStage(e.target.value as FeedbackStage)}
          >
            {ALL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted">Note (optional, shown to reporter)</span>
          <input
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reproduced it — fix is in review."
          />
        </label>

        <button
          onClick={applyStage}
          disabled={busy || !stageDirty || (nextStage === "DECLINED" && !declineReason.trim())}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          Apply
        </button>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted">Priority</span>
          <select
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            value={priority ?? ""}
            onChange={(e) => patch({ priority: e.target.value || null })}
            disabled={busy}
          >
            <option value="">—</option>
            {(Object.keys(PRIORITY_LABELS) as FeedbackPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {nextStage === "DECLINED" && (
        <div className="mt-2">
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Why it's declined — the reporter sees this."
          />
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground"
          value={github}
          onChange={(e) => setGithub(e.target.value)}
          placeholder="GitHub issue URL (optional mirror)"
        />
        <button
          onClick={() => patch({ githubUrl: github.trim() || null })}
          disabled={busy || github.trim() === (githubUrl ?? "")}
          className="rounded border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-40"
        >
          Save link
        </button>
      </div>

      {err && <p className="mt-2 text-sm text-error">{err}</p>}
    </div>
  );
}
