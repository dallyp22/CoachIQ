"use client";

import { useEffect, useState } from "react";
import { inputClass } from "@/components/modal";

/**
 * Pipeline stage settings (PRD §13.6).
 *
 * Deliberately small: rename, reorder, and mark a stage hot. No adding,
 * deleting, or changing which stage means won/lost — those are the operations
 * that can strand the convert-to-client rule, and the database rejects half of
 * them anyway.
 *
 * It exists because §7.1's Hot Prospects report and §10.1's open question both
 * depend on this being editable. Without it the module would ship a report
 * asserting which leads are hot, next to stage names the team has already said
 * are wrong, with no way to correct either.
 */

type Stage = {
  id: string;
  name: string;
  sortOrder: number;
  isHot: boolean;
  terminal: "WON" | "LOST" | null;
  isArchived: boolean;
};

export function PipelineStagesSection() {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [dirty, setDirty] = useState<Record<string, Partial<Stage>>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/pipeline/stages")
      .then((r) => r.json())
      .then((d) => setStages(d.stages ?? []))
      .catch(() => setErr("Could not load pipeline stages."));
  }, []);

  function edit(id: string, patch: Partial<Stage>) {
    setDirty((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setStages((s) => s?.map((st) => (st.id === id ? { ...st, ...patch } : st)) ?? null);
    setSaved(false);
  }

  function move(index: number, direction: -1 | 1) {
    if (!stages) return;
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;

    const reordered = [...stages];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    // Renumber the whole list rather than swapping two values: sortOrder gaps
    // from earlier edits would otherwise make the swap a no-op.
    const renumbered = reordered.map((s, i) => ({ ...s, sortOrder: i + 1 }));
    setStages(renumbered);
    setDirty((d) => {
      const next = { ...d };
      renumbered.forEach((s) => {
        next[s.id] = { ...next[s.id], sortOrder: s.sortOrder };
      });
      return next;
    });
    setSaved(false);
  }

  async function save() {
    const patches = Object.entries(dirty).map(([id, fields]) => ({ id, ...fields }));
    if (patches.length === 0) return;

    setSaving(true);
    setErr(null);
    try {
      const resp = await fetch("/api/pipeline/stages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stages: patches }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.error ?? "Could not save stages.");
        return;
      }
      setStages(data.stages);
      setDirty({});
      setSaved(true);
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = Object.keys(dirty).length > 0;

  return (
    <section className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
        <h2 className="font-display text-xl text-foreground">Pipeline stages</h2>
        {hasChanges && (
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
      <p className="text-sm text-muted mb-5 leading-relaxed">
        Rename and reorder to match how the team actually sells. &ldquo;Hot&rdquo; stages are the
        ones that appear in the Hot Prospects report.
      </p>

      {err && (
        <p className="text-sm text-error mb-4 px-3 py-2 bg-error/10 border border-error/25 rounded">
          {err}
        </p>
      )}
      {saved && !hasChanges && <p className="text-sm text-success mb-4">Stages updated.</p>}

      {stages === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : stages.length === 0 ? (
        <p className="text-sm text-muted">No stages configured.</p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded overflow-hidden">
          {stages.map((stage, i) => (
            <li key={stage.id} className="flex items-center gap-3 px-3 py-2.5 bg-background">
              <div className="flex flex-col shrink-0">
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${stage.name} up`}
                  className="text-muted hover:text-foreground disabled:opacity-25 disabled:hover:text-muted transition-colors leading-none"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
                  </svg>
                </button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === stages.length - 1}
                  aria-label={`Move ${stage.name} down`}
                  className="text-muted hover:text-foreground disabled:opacity-25 disabled:hover:text-muted transition-colors leading-none"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>

              <input
                className={`${inputClass} flex-1 min-w-0`}
                value={stage.name}
                onChange={(e) => edit(stage.id, { name: e.target.value })}
                aria-label={`Stage ${i + 1} name`}
              />

              {stage.terminal ? (
                // Terminal stages cannot be hot: a closed deal is not a lead to
                // chase, and the report filters open prospects only.
                <span
                  className="text-[11px] uppercase tracking-wide text-muted font-medium w-16 text-center shrink-0"
                  title={
                    stage.terminal === "WON"
                      ? "Reaching this stage offers to create a client"
                      : "Reaching this stage requires a reason"
                  }
                >
                  {stage.terminal.toLowerCase()}
                </span>
              ) : (
                <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer w-16 shrink-0">
                  <input
                    type="checkbox"
                    checked={stage.isHot}
                    onChange={(e) => edit(stage.id, { isHot: e.target.checked })}
                    className="accent-[var(--accent)]"
                  />
                  Hot
                </label>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-muted mt-4 leading-snug">
        Stages can&apos;t be added or removed here. The won and lost stages drive the
        convert-to-client flow, so exactly one of each always exists.
      </p>
    </section>
  );
}
