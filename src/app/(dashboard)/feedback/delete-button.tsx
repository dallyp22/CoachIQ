"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Delete a report for good. Two-step inline confirm (not a browser dialog):
 * the first click reveals Yes/No, so a stray click never destroys anything.
 */
export function DeleteButton({ id, compact = false }: { id: string; compact?: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function del() {
    setBusy(true);
    try {
      const resp = await fetch(`/api/feedback/${id}`, { method: "DELETE" });
      if (resp.ok) {
        router.refresh();
        return;
      }
      setBusy(false);
      setConfirming(false);
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className={`text-muted transition-colors hover:text-error ${compact ? "text-[11px]" : "text-xs"}`}
      >
        Delete
      </button>
    );
  }

  return (
    <span className={`inline-flex items-center gap-2 ${compact ? "text-[11px]" : "text-xs"}`}>
      <span className="text-muted">Delete?</span>
      <button onClick={del} disabled={busy} className="font-medium text-error hover:underline disabled:opacity-50">
        {busy ? "Deleting…" : "Yes"}
      </button>
      <button onClick={() => setConfirming(false)} disabled={busy} className="text-muted hover:text-foreground">
        No
      </button>
    </span>
  );
}
