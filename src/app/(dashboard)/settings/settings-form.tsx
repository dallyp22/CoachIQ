"use client";

import { useState, useEffect } from "react";
import { CleanSlateModal } from "./clean-slate-modal";

interface Settings {
  id: string;
  coachName: string;
  coachEmail: string;
  businessName: string;
  defaultHourlyRate: number;
  defaultBillingCadence: string;
  defaultBillingDayOfMonth: number | null;
  autoApproveUnderCents: number | null;
  invoicePrefix: string;
  invoiceNumberPadding: number;
  timezone: string;
  briefDeliveryMinutes: number;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  stripeSecretKey: string | null;
  googleCalendarId: string | null;
  coachingTitleFilter: string | null;
}

interface ResetCounts {
  invoices: number;
  adjustments: number;
  timeEntries: number;
  clientsWithStripe: number;
}

export function SettingsForm() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [calendarTest, setCalendarTest] = useState<{
    status: "idle" | "testing" | "connected" | "error";
    message?: string;
  }>({ status: "idle" });
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetCounts, setResetCounts] = useState<ResetCounts | null>(null);
  const [resetToast, setResetToast] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings);
  }, []);

  async function openResetModal() {
    // Fetch live counts before opening so the modal shows accurate numbers
    try {
      const resp = await fetch("/api/admin/billing/reset-preview");
      if (resp.ok) {
        const data = await resp.json();
        setResetCounts(data);
      } else {
        // Fallback if preview endpoint not yet built
        setResetCounts({ invoices: 0, adjustments: 0, timeEntries: 0, clientsWithStripe: 0 });
      }
    } catch {
      setResetCounts({ invoices: 0, adjustments: 0, timeEntries: 0, clientsWithStripe: 0 });
    }
    setResetModalOpen(true);
  }

  function handleResetComplete() {
    setResetModalOpen(false);
    setResetToast("Billing data reset. All invoices wiped, time entries restored.");
    setTimeout(() => setResetToast(null), 5000);
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    try {
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await resp.json();
      setSettings(data.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="animate-pulse">
        <div className="h-8 bg-border/50 rounded w-48 mb-8" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-border/30 rounded" />
          ))}
        </div>
      </div>
    );
  }

  function update(field: keyof Settings, value: string | number | null) {
    setSettings({ ...settings!, [field]: value });
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Settings</h1>
          <p className="text-sm text-muted mt-1">
            Coach profile, billing defaults, and integrations
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-success">Saved</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      <div className="space-y-10">
        {/* Coach Profile */}
        <Section title="Coach Profile">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Name" value={settings.coachName} onChange={(v) => update("coachName", v)} />
            <Field label="Email" value={settings.coachEmail} onChange={(v) => update("coachEmail", v)} />
            <Field label="Business Name" value={settings.businessName} onChange={(v) => update("businessName", v)} />
            <Field
              label="Default Hourly Rate"
              value={String(settings.defaultHourlyRate)}
              onChange={(v) => update("defaultHourlyRate", v)}
              prefix="$"
              type="number"
            />
          </div>
        </Section>

        {/* AI API Keys */}
        {/* These practice-level keys are encrypted at rest via src/lib/secrets.ts
            (AES-256-GCM), the same envelope the per-coach Fathom secrets use.
            The API only ever returns a "•••1234" mask; the raw key never leaves
            the server after it is saved. */}
        <Section title="AI API Keys" description="Used for session synopses, prep briefs, semantic search, and embeddings. Stored encrypted at rest; only the last four characters are shown once saved.">
          <div className="grid grid-cols-1 gap-4">
            <Field
              label="OpenAI API Key"
              value={settings.openaiApiKey || ""}
              onChange={(v) => update("openaiApiKey", v)}
              placeholder="sk-..."
              mono
            />
            <Field
              label="Anthropic API Key"
              value={settings.anthropicApiKey || ""}
              onChange={(v) => update("anthropicApiKey", v)}
              placeholder="sk-ant-..."
              mono
            />
          </div>
        </Section>

        {/* Stripe */}
        <Section title="Stripe" description="For sending invoices and collecting payments from clients.">
          <Field
            label="Stripe Secret Key"
            value={settings.stripeSecretKey || ""}
            onChange={(v) => update("stripeSecretKey", v)}
            placeholder="sk_live_... or sk_test_..."
            mono
          />
        </Section>

        {/* Integrations */}
        <Section title="Integrations" description="Connect Google Calendar to power daily briefs, prep briefs, and session tracking for non-Fathom clients.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Field
                label="Google Calendar ID"
                value={settings.googleCalendarId || ""}
                onChange={(v) => update("googleCalendarId", v)}
                placeholder="primary or todd@growwithcocreate.com"
              />
              <button
                onClick={async () => {
                  setCalendarTest({ status: "testing" });
                  try {
                    const res = await fetch("/api/calendar/test");
                    const data = await res.json();
                    if (data.status === "connected") {
                      setCalendarTest({
                        status: "connected",
                        message: `Connected to "${data.calendar.summary}" (${data.upcomingEvents} upcoming events)`,
                      });
                    } else {
                      setCalendarTest({
                        status: "error",
                        message: data.setup || data.error,
                      });
                    }
                  } catch {
                    setCalendarTest({
                      status: "error",
                      message: "Failed to reach the test endpoint.",
                    });
                  }
                }}
                disabled={calendarTest.status === "testing"}
                className="mt-2 px-3 py-1.5 text-xs font-medium border border-border rounded hover:bg-border/30 transition-colors disabled:opacity-50"
              >
                {calendarTest.status === "testing" ? "Testing..." : "Test Connection"}
              </button>
              {calendarTest.status === "connected" && (
                <p className="mt-1.5 text-xs text-success">{calendarTest.message}</p>
              )}
              {calendarTest.status === "error" && (
                <p className="mt-1.5 text-xs text-error">{calendarTest.message}</p>
              )}
            </div>
            <Field
              label="Coaching Title Filter (regex)"
              value={settings.coachingTitleFilter || ""}
              onChange={(v) => update("coachingTitleFilter", v)}
              placeholder="coaching|executive coaching|session"
              mono
            />
          </div>
          <p className="text-xs text-muted mt-3">
            Share your calendar with <span className="font-mono text-foreground/70">coachiq-pipeline@coachiq-491616.iam.gserviceaccount.com</span> (read-only) to enable calendar features.
          </p>
        </Section>

        {/* Billing Defaults */}
        <Section title="Billing Defaults" description="House rules for new clients. Per-client values override these.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted font-medium block mb-1.5">Default Billing Cadence</label>
              <select
                value={settings.defaultBillingCadence}
                onChange={(e) => update("defaultBillingCadence", e.target.value)}
                className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm outline-none focus:border-accent"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Biweekly</option>
                <option value="MONTHLY">Monthly</option>
                <option value="CUSTOM_DAYS">Custom days</option>
              </select>
            </div>
            <Field
              label="Default Day of Month (1-28)"
              value={settings.defaultBillingDayOfMonth?.toString() ?? ""}
              onChange={(v) => update("defaultBillingDayOfMonth", v === "" ? null : Number(v))}
              type="number"
              placeholder="e.g. 1 for the 1st"
            />
            <Field
              label="Auto-approve under (cents)"
              value={settings.autoApproveUnderCents?.toString() ?? ""}
              onChange={(v) => update("autoApproveUnderCents", v === "" ? null : Number(v))}
              type="number"
              placeholder="Leave empty to disable"
            />
            <Field
              label="Invoice Number Prefix"
              value={settings.invoicePrefix}
              onChange={(v) => update("invoicePrefix", v)}
              placeholder="CIQ"
              mono
            />
            <Field
              label="Timezone"
              value={settings.timezone}
              onChange={(v) => update("timezone", v)}
              placeholder="America/Chicago"
              mono
            />
            <Field
              label="Prep Brief Delivery (minutes before session)"
              value={String(settings.briefDeliveryMinutes)}
              onChange={(v) => update("briefDeliveryMinutes", v)}
              type="number"
            />
          </div>
        </Section>

        {/* Danger Zone */}
        <Section
          title="Danger Zone"
          description="Irreversible operations. Use only when rebuilding billing state from scratch."
        >
          {resetToast && (
            <div className="mb-3 px-3 py-2 bg-success/10 border border-success/30 text-success text-sm rounded">
              {resetToast}
            </div>
          )}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium text-foreground">Reset all billing data</p>
              <p className="text-xs text-muted mt-1">
                Deletes every invoice and adjustment, resets time entries to unbilled.
                Stripe customers preserved by default.
              </p>
            </div>
            <button
              type="button"
              onClick={openResetModal}
              className="px-4 py-2 text-sm font-medium border border-error/40 text-error rounded hover:bg-error/10 transition-colors"
            >
              Reset billing data…
            </button>
          </div>
        </Section>
      </div>

      {resetModalOpen && resetCounts && (
        <CleanSlateModal
          open={resetModalOpen}
          onClose={() => setResetModalOpen(false)}
          onComplete={handleResetComplete}
          counts={resetCounts}
        />
      )}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
      <h2 className="font-display text-lg text-foreground mb-1">{title}</h2>
      {description && (
        <p className="text-xs text-muted mb-4">{description}</p>
      )}
      {!description && <div className="mb-4" />}
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  prefix,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  prefix?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-muted font-medium block mb-1.5">
        {label}
      </label>
      <div className="flex items-center">
        {prefix && <span className="text-sm text-muted mr-1">{prefix}</span>}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full bg-background border border-border rounded px-3 py-2.5 text-sm outline-none focus:border-accent ${
            mono ? "font-mono" : ""
          }`}
        />
      </div>
    </div>
  );
}
