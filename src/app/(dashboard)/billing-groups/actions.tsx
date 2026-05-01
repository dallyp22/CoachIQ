"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreateGroupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
      >
        New group
      </button>
      {open && <CreateGroupModal onClose={() => setOpen(false)} />}
    </>
  );
}

function CreateGroupModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [cadence, setCadence] = useState("MONTHLY");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const resp = await fetch("/api/billing-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          billingContactEmail: email,
          billingContactName: contactName || undefined,
          hourlyRate: hourlyRate || null,
          billingCadence: cadence,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.error || "Failed to create group");
        return;
      }
      router.push(`/billing-groups/${data.id}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-[var(--radius-lg)] p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-xl text-foreground mb-4">Create billing group</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-muted font-medium block mb-1">Group name *</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs text-muted font-medium block mb-1">Billing contact email *</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ap@acme.com"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted font-medium block mb-1">Billing contact name</label>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Optional"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted font-medium block mb-1">Rate override</label>
              <input
                type="number"
                step="0.01"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                placeholder="Leave blank to use member rates"
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-muted font-medium block mb-1">Cadence</label>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Biweekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
          </div>
          {err && <p className="text-sm text-error">{err}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create group"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
