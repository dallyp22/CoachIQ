"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * SnapshotBanner — shown ONLY when invoice snapshot fields drift from current
 * client values. Per the design review decision: keep the signal sharp,
 * never show "snapshot OK" as wallpaper.
 *
 * Drift detection happens server-side in lib/billing/snapshot.detectDrift()
 * and the resulting list of changed-field labels is passed in as `driftedFields`.
 *
 * Visual: Amber-100 (`bg-accent-light`) strip with thin Amber-200 border, an
 * outlined info glyph, microcopy describing what drifted, and a text-button
 * "Refresh from client →" that POSTs to the refresh endpoint.
 */
export function SnapshotBanner({
  invoiceId,
  driftedFields,
  snapshotDate,
  onRefreshed,
}: {
  invoiceId: string;
  driftedFields: string[];
  snapshotDate: Date | string;
  onRefreshed?: () => void;
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRefreshed, setJustRefreshed] = useState(false);

  if (driftedFields.length === 0 && !justRefreshed) return null;

  // Stone-500 status row after a refresh, auto-hides via parent re-render
  if (justRefreshed) {
    return (
      <div className="flex items-center justify-between text-xs text-muted py-2 px-3 mb-3">
        <span>Snapshot updated · just now</span>
      </div>
    );
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const resp = await fetch(`/api/invoices/${invoiceId}/refresh-from-client`, {
        method: "POST",
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || "Refresh failed");
      }
      setJustRefreshed(true);
      onRefreshed?.();
      router.refresh();
      // Status row visible for 5s then disappears via re-render driven by router.refresh
      setTimeout(() => setJustRefreshed(false), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  const dateStr = new Date(snapshotDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 bg-accent-light border border-accent/20 rounded px-3 py-2.5 mb-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <InfoGlyph />
        <p className="text-xs text-foreground truncate">
          {error ? (
            <span className="text-error">Could not refresh — try again</span>
          ) : (
            <>
              Showing snapshot from {dateStr} — client info edited since (
              {driftedFields.join(", ")})
            </>
          )}
        </p>
      </div>
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="text-xs font-medium text-accent hover:text-accent-hover whitespace-nowrap disabled:opacity-50"
      >
        {refreshing ? "Refreshing…" : "Refresh from client →"}
      </button>
    </div>
  );
}

function InfoGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="text-accent flex-shrink-0"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4.5v.01M7 6.5v3" strokeLinecap="round" />
    </svg>
  );
}
