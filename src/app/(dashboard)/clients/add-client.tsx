"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Add clients — one at a time, or a whole roster pasted in.
 *
 * Onboarding a coach means entering their entire client list in one sitting,
 * so the paste mode is the primary path during setup, not a power-user extra.
 */

export function AddClientButton({ defaultRate }: { defaultRate: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
      >
        Add client
      </button>
      {open && <AddClientModal defaultRate={defaultRate} onClose={() => setOpen(false)} />}
    </>
  );
}

type Failure = { email: string; error: string };

function AddClientModal({
  defaultRate,
  onClose,
}: {
  defaultRate: number | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"single" | "paste">("single");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; failed: Failure[] } | null>(null);

  const [single, setSingle] = useState({
    name: "",
    email: "",
    company: "",
    hourlyRate: "",
  });
  const [pasted, setPasted] = useState("");

  /**
   * Accepts "Name, email, company, rate" per line — the shape of a list
   * someone copies out of a spreadsheet or an email. Tabs and commas both
   * work so a direct paste from Sheets lands correctly.
   */
  function parsePasted(text: string) {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, email, company, rate] = line.split(/\t|,/).map((p) => p?.trim() ?? "");
        return {
          name,
          email,
          company: company || undefined,
          hourlyRate: rate || undefined,
        };
      });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const clients = mode === "single" ? [single] : parsePasted(pasted);
      if (clients.length === 0) {
        setErr("Nothing to add.");
        return;
      }

      const resp = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clients }),
      });
      const data = await resp.json();

      if (!resp.ok && !data.created) {
        setErr(data.error || data.failed?.[0]?.error || "Could not add clients.");
        return;
      }

      // 207 means some landed and some didn't — show both rather than
      // discarding the good rows.
      setResult({ created: data.created?.length ?? 0, failed: data.failed ?? [] });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <Modal onClose={onClose}>
        <h2 className="font-display text-xl text-foreground mb-2">
          {result.created} client{result.created === 1 ? "" : "s"} added
        </h2>
        {result.failed.length > 0 && (
          <>
            <p className="text-sm text-muted mb-3">
              These were skipped — the rest were added, so only fix these:
            </p>
            <ul className="space-y-1.5 mb-4">
              {result.failed.map((f, i) => (
                <li key={i} className="text-sm">
                  <span className="font-mono text-xs text-foreground">{f.email}</span>
                  <span className="text-muted"> — {f.error}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          onClick={onClose}
          className="mt-2 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
        >
          Done
        </button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-display text-xl text-foreground mb-1">Add clients</h2>
      <p className="text-sm text-muted mb-4">
        The email you enter is the one they join sessions with — it&apos;s how recordings find
        the right client.
      </p>

      <div className="flex gap-1 mb-4 border-b border-border">
        {(["single", "paste"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              mode === m
                ? "border-accent text-foreground font-medium"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {m === "single" ? "One client" : "Paste a list"}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === "single" ? (
          <>
            <Field label="Name *">
              <input
                required
                value={single.name}
                onChange={(e) => setSingle({ ...single, name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Session email *">
              <input
                required
                type="email"
                value={single.email}
                onChange={(e) => setSingle({ ...single, email: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Company">
              <input
                value={single.company}
                onChange={(e) => setSingle({ ...single, company: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field
              label="Hourly rate"
              hint={defaultRate ? `Leave blank to use your default of $${defaultRate}.` : undefined}
            >
              <input
                inputMode="decimal"
                placeholder={defaultRate ? String(defaultRate) : ""}
                value={single.hourlyRate}
                onChange={(e) => setSingle({ ...single, hourlyRate: e.target.value })}
                className={inputClass}
              />
            </Field>
          </>
        ) : (
          <Field
            label="One client per line"
            hint="Name, email, company, rate — commas or tabs. Company and rate are optional. Pastes straight from a spreadsheet."
          >
            <textarea
              rows={8}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={"Alice Johnson, alice@acme.com, Acme Corp, 300\nJohn Smith, john@client.com"}
              className={`${inputClass} font-mono text-xs leading-relaxed`}
            />
          </Field>
        )}

        {err && <p className="text-sm text-[#B91C1C]">{err}</p>}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 border border-border text-sm rounded hover:bg-background transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

const inputClass =
  "w-full px-3 py-2 border border-border rounded bg-background text-sm text-foreground";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs text-muted font-medium block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-[var(--radius-lg)] p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
