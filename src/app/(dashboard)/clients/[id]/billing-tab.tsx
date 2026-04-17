"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface BillingClient {
  id: string;
  name: string;
  displayName: string | null;
  email: string;
  hourlyRate: number;
  billingCadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM_DAYS";
  customCadenceDays: number | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  secondaryEmails: string[];
  billingPausedUntil: string | null;
  billingNotes: string | null;
  retainer: number;
}

interface Preview {
  nextDate: string;
  unbilledHours: number;
  estimatedSubtotal: number;
  retainerToApply: number;
  estimatedTotal: number;
  paused: boolean;
  pausedUntil: string | null;
  timezone: string;
}

const cadenceLabels: Record<BillingClient["billingCadence"], string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  MONTHLY: "Monthly",
  CUSTOM_DAYS: "Custom days",
};

/**
 * BillingTab — content of the "Billing" tab on /clients/[id].
 *
 * Layout per /plan-design-review (variant A approved):
 *   1. Next-invoice preview strip (live-recomputes on cadence/customDays change)
 *   2. 2-col Cadence+Identity grid
 *   3. Retainer strip
 *   4. Notes textarea
 */
export function BillingTab({ client }: { client: BillingClient }) {
  const router = useRouter();
  const [form, setForm] = useState({
    displayName: client.displayName ?? "",
    billingContactName: client.billingContactName ?? "",
    billingContactEmail: client.billingContactEmail ?? "",
    secondaryEmails: client.secondaryEmails,
    hourlyRate: String(client.hourlyRate),
    billingCadence: client.billingCadence,
    customCadenceDays: client.customCadenceDays ?? 14,
    billingPausedUntil: client.billingPausedUntil
      ? client.billingPausedUntil.slice(0, 10)
      : "",
    billingNotes: client.billingNotes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [retainerInput, setRetainerInput] = useState("");
  const [retainerBalance, setRetainerBalance] = useState(client.retainer);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live-recompute preview when cadence-relevant fields change (250ms debounce)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPreviewLoading(true);
      const params = new URLSearchParams({
        cadence: form.billingCadence,
      });
      if (form.billingCadence === "CUSTOM_DAYS") {
        params.set("customDays", String(form.customCadenceDays));
      }
      fetch(`/api/clients/${client.id}/billing-preview?${params}`)
        .then((r) => r.json())
        .then((data) => {
          if (!data.error) setPreview(data);
        })
        .finally(() => setPreviewLoading(false));
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [form.billingCadence, form.customCadenceDays, client.id]);

  const previewDateStr = useMemo(() => {
    if (!preview) return "—";
    return new Date(preview.nextDate).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }, [preview]);

  function update<K extends keyof typeof form>(field: K, value: (typeof form)[K]) {
    setForm({ ...form, [field]: value });
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const resp = await fetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.displayName,
          billingContactName: form.billingContactName,
          billingContactEmail: form.billingContactEmail,
          secondaryEmails: form.secondaryEmails,
          hourlyRate: form.hourlyRate,
          billingCadence: form.billingCadence,
          customCadenceDays:
            form.billingCadence === "CUSTOM_DAYS" ? form.customCadenceDays : null,
          billingPausedUntil: form.billingPausedUntil || null,
          billingNotes: form.billingNotes,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      setSaved(true);
      router.refresh();
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddRetainer() {
    const amount = parseFloat(retainerInput);
    if (!amount || amount <= 0) {
      setError("Enter a positive amount");
      return;
    }
    const newBalance = retainerBalance + amount;
    try {
      const resp = await fetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retainer: newBalance }),
      });
      if (!resp.ok) throw new Error("Add failed");
      setRetainerBalance(newBalance);
      setRetainerInput("");
      router.refresh();
    } catch {
      setError("Could not add retainer");
    }
  }

  function addCcEmail(email: string) {
    const trimmed = email.trim();
    if (!trimmed || form.secondaryEmails.includes(trimmed)) return;
    update("secondaryEmails", [...form.secondaryEmails, trimmed]);
  }

  function removeCcEmail(email: string) {
    update(
      "secondaryEmails",
      form.secondaryEmails.filter((e) => e !== email),
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-2xl text-foreground">Billing</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm text-success">Saved</span>}
          {error && <span className="text-sm text-error">{error}</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

      {/* 1. Next-invoice preview strip */}
      <NextInvoiceStrip
        preview={preview}
        previewLoading={previewLoading}
        previewDateStr={previewDateStr}
        clientId={client.id}
      />

      {/* 2. Cadence + Identity grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="Cadence & Schedule">
          <FieldLabel label="Cadence" />
          <select
            value={form.billingCadence}
            onChange={(e) =>
              update("billingCadence", e.target.value as BillingClient["billingCadence"])
            }
            className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm outline-none focus:border-accent"
          >
            {(Object.keys(cadenceLabels) as Array<keyof typeof cadenceLabels>).map((k) => (
              <option key={k} value={k}>
                {cadenceLabels[k]}
              </option>
            ))}
          </select>
          {form.billingCadence === "CUSTOM_DAYS" && (
            <div className="mt-3">
              <FieldLabel label="Days between invoices" />
              <input
                type="number"
                min={1}
                max={365}
                value={form.customCadenceDays}
                onChange={(e) => update("customCadenceDays", parseInt(e.target.value) || 1)}
                className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono outline-none focus:border-accent"
              />
            </div>
          )}
          <div className="mt-4">
            <FieldLabel label="Hourly rate override" />
            <div className="flex items-center">
              <span className="text-sm text-muted mr-1">$</span>
              <input
                type="number"
                step="0.01"
                value={form.hourlyRate}
                onChange={(e) => update("hourlyRate", e.target.value)}
                className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono outline-none focus:border-accent"
              />
            </div>
          </div>
          <div className="mt-4">
            <FieldLabel label="Pause billing through" />
            <input
              type="date"
              value={form.billingPausedUntil}
              onChange={(e) => update("billingPausedUntil", e.target.value)}
              className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono outline-none focus:border-accent"
            />
            {form.billingPausedUntil && (
              <button
                type="button"
                onClick={() => update("billingPausedUntil", "")}
                className="mt-1 text-xs text-muted hover:text-accent"
              >
                Clear pause
              </button>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Billing Identity">
          <FieldLabel label="Display name" />
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => update("displayName", e.target.value)}
            placeholder={client.name}
            className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm outline-none focus:border-accent"
          />
          <p className="text-xs text-muted mt-1">
            Shown on invoices; falls back to {client.name}
          </p>

          <div className="mt-4">
            <FieldLabel label="Billing contact name" />
            <input
              type="text"
              value={form.billingContactName}
              onChange={(e) => update("billingContactName", e.target.value)}
              placeholder="Optional"
              className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="mt-4">
            <FieldLabel label="Billing contact email" />
            <input
              type="email"
              value={form.billingContactEmail}
              onChange={(e) => update("billingContactEmail", e.target.value)}
              placeholder={client.email}
              className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono outline-none focus:border-accent"
            />
            <p className="text-xs text-muted mt-1">Falls back to {client.email}</p>
          </div>

          <div className="mt-4">
            <FieldLabel label="CC emails" />
            <CcEmailChips
              emails={form.secondaryEmails}
              onAdd={addCcEmail}
              onRemove={removeCcEmail}
            />
          </div>
        </SectionCard>
      </div>

      {/* 3. Retainer */}
      <SectionCard>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-baseline gap-3">
            <FieldLabel label="Retainer balance" />
            <span className="font-mono text-2xl font-medium text-accent">
              ${retainerBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.01"
              value={retainerInput}
              onChange={(e) => setRetainerInput(e.target.value)}
              placeholder="Amount"
              className="w-32 bg-background border border-border rounded px-3 py-2 text-sm font-mono outline-none focus:border-accent"
            />
            <button
              onClick={handleAddRetainer}
              disabled={!retainerInput}
              className="px-3 py-2 text-sm font-medium border border-border rounded hover:bg-border/30 transition-colors disabled:opacity-50"
            >
              Add retainer
            </button>
          </div>
        </div>
        <p className="text-xs text-muted mt-2">
          Will appear as a negative line item on the next invoice
        </p>
      </SectionCard>

      {/* 4. Notes */}
      <SectionCard title="Notes for invoices">
        <textarea
          value={form.billingNotes}
          onChange={(e) => update("billingNotes", e.target.value)}
          rows={3}
          placeholder="Anything that should travel with this client's invoices (PO numbers, billing instructions, etc.)"
          className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm outline-none focus:border-accent resize-none"
        />
      </SectionCard>
    </div>
  );
}

function NextInvoiceStrip({
  preview,
  previewLoading,
  previewDateStr,
  clientId,
}: {
  preview: Preview | null;
  previewLoading: boolean;
  previewDateStr: string;
  clientId: string;
}) {
  if (preview?.paused && preview.pausedUntil) {
    const pauseEnd = new Date(preview.pausedUntil).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return (
      <div className="bg-surface border border-border rounded-[var(--radius-md)] px-5 py-4">
        <p className="text-sm text-foreground">
          Paused through <span className="font-mono">{pauseEnd}</span>
        </p>
      </div>
    );
  }

  const noWork = preview && preview.unbilledHours === 0;

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-md)] px-5 py-4 flex items-baseline justify-between gap-4 flex-wrap">
      <div>
        <p className="text-xs text-muted uppercase tracking-wide font-medium mb-1">
          Next invoice preview
        </p>
        {previewLoading && !preview ? (
          <p className="text-sm text-muted">Calculating…</p>
        ) : noWork ? (
          <p className="text-sm text-foreground">
            No invoice scheduled — add billable sessions first
          </p>
        ) : preview ? (
          <p className="text-sm text-foreground">
            Generates <span className="font-mono">{previewDateStr}</span> —{" "}
            <span className="font-mono text-2xl text-accent">
              ${preview.estimatedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>{" "}
            from {preview.unbilledHours.toFixed(2)} unbilled hrs
            {preview.retainerToApply > 0 && (
              <span className="text-xs text-muted ml-2">
                (after ${preview.retainerToApply.toFixed(2)} retainer)
              </span>
            )}
          </p>
        ) : (
          <p className="text-sm text-muted">—</p>
        )}
      </div>
      <SkipCycleLink clientId={clientId} disabled={noWork ?? false} />
    </div>
  );
}

function SkipCycleLink({ clientId, disabled }: { clientId: string; disabled: boolean }) {
  // Placeholder — full skip-cycle popover is a follow-up. For now, surface
  // the affordance so Todd knows the capability exists.
  return (
    <button
      type="button"
      disabled={disabled}
      title="Coming soon — will let you skip this cycle with a logged reason"
      className="text-xs text-muted hover:text-accent disabled:opacity-50"
    >
      Skip this cycle
    </button>
  );
}

function SectionCard({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
      {title && (
        <h3 className="text-xs text-muted uppercase tracking-wide font-medium mb-3">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

function FieldLabel({ label }: { label: string }) {
  return (
    <label className="text-xs text-muted font-medium block mb-1.5">
      {label}
    </label>
  );
}

function CcEmailChips({
  emails,
  onAdd,
  onRemove,
}: {
  emails: string[];
  onAdd: (email: string) => void;
  onRemove: (email: string) => void;
}) {
  const [input, setInput] = useState("");

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (input.trim()) {
        onAdd(input);
        setInput("");
      }
    }
  }

  return (
    <div className="border border-border rounded px-2 py-2 min-h-[42px] flex flex-wrap items-center gap-1.5 bg-background">
      {emails.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-border/30 rounded"
        >
          {email}
          <button
            type="button"
            onClick={() => onRemove(email)}
            className="text-muted hover:text-error"
            aria-label={`Remove ${email}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="email"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (input.trim()) {
            onAdd(input);
            setInput("");
          }
        }}
        placeholder={emails.length === 0 ? "Type email + Enter to add" : ""}
        className="flex-1 min-w-[180px] bg-transparent text-sm font-mono outline-none px-1"
      />
    </div>
  );
}
