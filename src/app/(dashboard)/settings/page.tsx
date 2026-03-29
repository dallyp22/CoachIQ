"use client";

import { useState, useEffect } from "react";

interface Settings {
  id: string;
  coachName: string;
  coachEmail: string;
  businessName: string;
  defaultHourlyRate: number;
  defaultBillingCadence: string;
  briefDeliveryMinutes: number;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  stripeSecretKey: string | null;
  googleCalendarId: string | null;
  coachingTitleFilter: string | null;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings);
  }, []);

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

  function update(field: keyof Settings, value: string) {
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
        <Section title="AI API Keys" description="Used for session synopses, prep briefs, semantic search, and embeddings. Keys are encrypted at rest.">
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
        <Section title="Integrations">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="Google Calendar ID"
              value={settings.googleCalendarId || ""}
              onChange={(v) => update("googleCalendarId", v)}
              placeholder="primary or calendar@group.calendar.google.com"
            />
            <Field
              label="Coaching Title Filter (regex)"
              value={settings.coachingTitleFilter || ""}
              onChange={(v) => update("coachingTitleFilter", v)}
              placeholder="coaching|executive coaching|session"
              mono
            />
          </div>
        </Section>

        {/* Billing Defaults */}
        <Section title="Billing Defaults">
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
              </select>
            </div>
            <Field
              label="Prep Brief Delivery (minutes before session)"
              value={String(settings.briefDeliveryMinutes)}
              onChange={(v) => update("briefDeliveryMinutes", v)}
              type="number"
            />
          </div>
        </Section>
      </div>
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
