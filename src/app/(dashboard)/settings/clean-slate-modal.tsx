"use client";

import { useEffect, useRef, useState } from "react";

interface ResetCounts {
  invoices: number;
  adjustments: number;
  timeEntries: number;
  clientsWithStripe: number;
}

/**
 * CleanSlateModal — typed-confirmation modal for the billing reset danger zone.
 *
 * Per /plan-design-review: calm not shouting. Disabled primary button is the
 * loud signal, not red borders. Placeholder shows "RESET" so Todd doesn't
 * have to hunt for the required string (Krug: don't make me think).
 *
 * Stripe-customer preservation defaults ON; toggling off requires explicit
 * action and shows aggressive warning copy.
 */
export function CleanSlateModal({
  open,
  onClose,
  onComplete,
  counts,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
  counts: ResetCounts;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [keepStripe, setKeepStripe] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus trap: focus the input on open
  useEffect(() => {
    if (open) {
      setConfirmText("");
      setError(null);
      // tiny defer so transition starts before focus
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // ESC closes
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const isValid = confirmText === "RESET";

  async function handleReset() {
    if (!isValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/admin/billing/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET", keepStripeCustomers: keepStripe }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || "Reset failed");
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/60 px-4"
    >
      <div className="bg-surface border border-border rounded-[var(--radius-lg)] shadow-xl w-full max-w-[520px] p-6">
        <h2 id="reset-title" className="font-display text-2xl text-foreground mb-1">
          Reset all billing data
        </h2>
        <p className="text-sm text-muted mb-5">
          This permanently deletes all invoices and resets time entries to unbilled.
        </p>

        <div className="bg-background border border-border rounded p-4 mb-4 font-mono text-sm">
          <Row label="Invoices to delete" value={counts.invoices} />
          <Row label="Adjustments to delete" value={counts.adjustments} />
          <Row label="Time entries to reset" value={counts.timeEntries} />
          <Row
            label={keepStripe ? "Stripe customers preserved" : "Stripe customers to clear"}
            value={counts.clientsWithStripe}
          />
        </div>

        <label className="flex items-start gap-3 mb-5 cursor-pointer">
          <input
            type="checkbox"
            checked={!keepStripe}
            onChange={(e) => setKeepStripe(!e.target.checked)}
            className="mt-0.5"
          />
          <div>
            <div className="text-sm text-foreground">Also clear Stripe customer IDs</div>
            <div className="text-xs text-muted mt-0.5">
              {keepStripe
                ? "Off keeps payment methods on file. Recommended unless rebuilding from scratch."
                : "Will require recreating Stripe customers + re-collecting payment methods."}
            </div>
          </div>
        </label>

        <label
          htmlFor="reset-confirm"
          className="text-xs text-muted uppercase tracking-wide font-medium block mb-1.5"
        >
          Type RESET to confirm
        </label>
        <input
          ref={inputRef}
          id="reset-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="RESET"
          className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono outline-none focus:border-accent"
          aria-describedby="reset-helper"
        />

        {error && (
          <div className="mt-3 text-sm text-error">{error}</div>
        )}

        <div className="flex items-center justify-between mt-6">
          <span id="reset-helper" className="text-xs text-muted">
            {isValid ? " " : "Type RESET to enable"}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium border border-border rounded hover:bg-border/30 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!isValid || submitting}
              aria-disabled={!isValid || submitting}
              className={`px-5 py-2 text-sm font-medium rounded transition-colors ${
                isValid && !submitting
                  ? "bg-accent text-white hover:bg-accent-hover"
                  : "bg-border/50 text-muted cursor-not-allowed"
              }`}
            >
              {submitting ? "Resetting…" : "Reset everything"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-foreground/80">{label}:</span>
      <span className="text-foreground tabular-nums">{value}</span>
    </div>
  );
}
