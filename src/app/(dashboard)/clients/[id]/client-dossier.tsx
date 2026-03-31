"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Session {
  id: string;
  title: string;
  date: string;
  durationMinutes: number;
  billableMinutes: number;
  recordingUrl: string | null;
  synopsis: string | null;
  sessionSource: string;
}

interface ClientData {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  hourlyRate: number;
  billingCadence: string;
  meetingCadence: string;
  allowsFathom: boolean;
  status: string;
  notes: string | null;
  tags: string[];
  sessionCount: number;
  notebookId: string | null;
  driveFolderId: string | null;
  sessions: Session[];
}

export function ClientDossier({ client }: { client: ClientData }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: client.name,
    email: client.email,
    phone: client.phone || "",
    company: client.company || "",
    hourlyRate: String(client.hourlyRate),
    billingCadence: client.billingCadence,
    meetingCadence: client.meetingCadence,
    allowsFathom: client.allowsFathom,
    status: client.status,
    notes: client.notes || "",
  });

  const totalBilledHours = client.sessions.reduce(
    (sum, s) => sum + s.billableMinutes / 60,
    0
  );

  function updateField(field: string, value: string) {
    setForm({ ...form, [field]: value });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone || null,
          company: form.company || null,
          hourlyRate: form.hourlyRate,
          billingCadence: form.billingCadence,
          meetingCadence: form.meetingCadence,
          allowsFathom: form.allowsFathom,
          status: form.status,
          notes: form.notes || null,
        }),
      });
      setEditing(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setForm({
      name: client.name,
      email: client.email,
      phone: client.phone || "",
      company: client.company || "",
      hourlyRate: String(client.hourlyRate),
      billingCadence: client.billingCadence,
      meetingCadence: client.meetingCadence,
      allowsFathom: client.allowsFathom,
      status: client.status,
      notes: client.notes || "",
    });
    setEditing(false);
  }

  return (
    <div>
      <Link
        href="/clients"
        className="text-sm text-muted hover:text-accent transition-colors"
      >
        &larr; All Clients
      </Link>

      {/* Profile Header */}
      <div className="mt-4 pb-6 border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            {editing ? (
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted font-medium">Name</label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => updateField("name", e.target.value)}
                      className="mt-1 w-full bg-background border border-border rounded px-3 py-2 font-display text-2xl outline-none focus:border-accent"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-muted font-medium">Company</label>
                    <input
                      type="text"
                      value={form.company}
                      onChange={(e) => updateField("company", e.target.value)}
                      placeholder="Company name"
                      className="mt-1 w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted font-medium">Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => updateField("email", e.target.value)}
                      className="mt-1 w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono outline-none focus:border-accent"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-muted font-medium">Phone</label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={(e) => updateField("phone", e.target.value)}
                      placeholder="Phone number"
                      className="mt-1 w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div>
                    <label className="text-xs text-muted font-medium">Hourly Rate</label>
                    <div className="mt-1 flex items-center">
                      <span className="text-sm text-muted mr-1">$</span>
                      <input
                        type="number"
                        value={form.hourlyRate}
                        onChange={(e) => updateField("hourlyRate", e.target.value)}
                        className="w-24 bg-background border border-border rounded px-3 py-2 text-sm font-mono outline-none focus:border-accent"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted font-medium">Billing Cadence</label>
                    <select
                      value={form.billingCadence}
                      onChange={(e) => updateField("billingCadence", e.target.value)}
                      className="mt-1 bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
                    >
                      <option value="WEEKLY">Weekly</option>
                      <option value="BIWEEKLY">Biweekly</option>
                      <option value="MONTHLY">Monthly</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted font-medium">Meeting Cadence</label>
                    <select
                      value={form.meetingCadence}
                      onChange={(e) => updateField("meetingCadence", e.target.value)}
                      className="mt-1 bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
                    >
                      <option value="WEEKLY">Weekly</option>
                      <option value="BIWEEKLY">Biweekly</option>
                      <option value="MONTHLY">Monthly</option>
                      <option value="AD_HOC">Ad Hoc</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted font-medium">Status</label>
                    <select
                      value={form.status}
                      onChange={(e) => updateField("status", e.target.value)}
                      className="mt-1 bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent"
                    >
                      <option value="ACTIVE">Active</option>
                      <option value="PAUSED">Paused</option>
                      <option value="CHURNED">Churned</option>
                      <option value="PROSPECT">Prospect</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.allowsFathom}
                      onChange={(e) => setForm({ ...form, allowsFathom: e.target.checked })}
                      className="accent-accent w-4 h-4"
                    />
                    <span className="text-xs text-muted font-medium">Records with Fathom</span>
                  </label>
                  {!form.allowsFathom && (
                    <span className="text-xs text-muted italic">Sessions tracked via Google Calendar</span>
                  )}
                </div>
                <div>
                  <label className="text-xs text-muted font-medium">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => updateField("notes", e.target.value)}
                    placeholder="Private coaching notes..."
                    rows={3}
                    className="mt-1 w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent resize-none"
                  />
                </div>
              </div>
            ) : (
              <>
                <h1 className="font-display text-4xl text-foreground leading-tight">
                  {client.name}
                </h1>
                {client.company && (
                  <p className="text-base text-muted mt-1">{client.company}</p>
                )}
                {client.notes && (
                  <p className="text-sm text-muted mt-2 italic">{client.notes}</p>
                )}
              </>
            )}
          </div>
          <div className="flex gap-2 shrink-0 mt-1">
            {!editing && (
              <>
                {client.notebookId ? (
                  <a
                    href={`https://notebooklm.google.com/notebook/${client.notebookId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
                  >
                    <NotebookIcon className="w-4 h-4" />
                    Open Notebook
                  </a>
                ) : (
                  <span className="flex items-center gap-2 px-4 py-2 bg-surface border border-border text-muted text-sm font-medium rounded cursor-default" title="Notebook ID not linked yet">
                    <NotebookIcon className="w-4 h-4" />
                    Notebook not linked
                  </span>
                )}
                {client.driveFolderId && (
                  <a
                    href={`https://drive.google.com/drive/folders/${client.driveFolderId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent hover:text-accent transition-colors"
                  >
                    Drive
                  </a>
                )}
                <NlmSyncButton clientId={client.id} clientName={client.name} notebookId={client.notebookId} />
              </>
            )}
          </div>
        </div>

        {/* Edit/Save buttons */}
        <div className="mt-4 flex gap-2">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-2 border border-border text-muted text-sm font-medium rounded hover:border-accent hover:text-accent transition-colors"
            >
              Edit Profile
            </button>
          )}
        </div>

        {!editing && (
          <div className="flex flex-wrap gap-6 mt-5">
            <MetaStat label="Sessions" value={String(client.sessionCount)} />
            <MetaStat
              label="Since"
              value={
                client.sessions.length > 0
                  ? new Date(
                      client.sessions[client.sessions.length - 1].date
                    ).toLocaleDateString("en-US", {
                      month: "short",
                      year: "numeric",
                    })
                  : "—"
              }
            />
            <MetaStat label="Rate" value={`$${client.hourlyRate}/hr`} />
            <MetaStat
              label="Cadence"
              value={client.meetingCadence.charAt(0) + client.meetingCadence.slice(1).toLowerCase()}
            />
            <MetaStat
              label="Status"
              value={client.status.charAt(0) + client.status.slice(1).toLowerCase()}
              accent
            />
          </div>
        )}
      </div>

      {/* Prep Brief */}
      <PrepBriefSection clientId={client.id} clientName={client.name} hasSessions={client.sessions.length > 0} />

      {/* Session Timeline */}
      <div className="mt-8">
        <h2 className="font-display text-xl text-foreground mb-4">
          Recent Sessions
        </h2>

        {client.sessions.length === 0 ? (
          <div className="py-12 text-center">
            <p className="font-display text-lg text-foreground">
              No sessions recorded yet for {client.name.split(" ")[0]}
            </p>
            <p className="text-sm text-muted mt-2">
              Sessions appear automatically from Fathom recordings or Google Calendar sync.
            </p>
          </div>
        ) : (
          <div className="space-y-0">
            {client.sessions.map((session) => (
              <div
                key={session.id}
                className="grid grid-cols-[90px_1fr] gap-4 py-3 border-b border-border last:border-b-0"
              >
                <span className="font-mono text-xs text-muted pt-0.5">
                  {new Date(session.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <div>
                  <h3 className="text-sm font-medium text-foreground">
                    {session.title}
                  </h3>
                  {session.synopsis && (
                    <p className="text-sm text-muted mt-1 line-clamp-2">
                      {session.synopsis}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    <span className="font-mono text-xs text-muted bg-surface border border-border px-2 py-0.5 rounded">
                      {session.durationMinutes} min
                    </span>
                    {session.sessionSource !== "FATHOM" && (
                      <span className={`font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
                        session.sessionSource === "CALENDAR"
                          ? "bg-blue-50 text-blue-600 border border-blue-200"
                          : "bg-stone-100 text-stone-500 border border-stone-200"
                      }`}>
                        {session.sessionSource === "CALENDAR" ? "Calendar" : "Manual"}
                      </span>
                    )}
                    {session.recordingUrl && (
                      <a
                        href={session.recordingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent hover:underline"
                      >
                        View Recording
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Billing Summary */}
      <div className="mt-10">
        <h2 className="font-display text-xl text-foreground mb-4">Billing</h2>
        <div className="space-y-0">
          <BillingRow label="Total Sessions" value={`${client.sessionCount} sessions`} />
          <BillingRow label="Total Hours" value={`${totalBilledHours.toFixed(1)} hrs`} />
          <BillingRow label="Rate" value={`$${client.hourlyRate}/hr`} />
        </div>
      </div>
    </div>
  );
}

function PrepBriefSection({
  clientId,
  clientName,
  hasSessions,
}: {
  clientId: string;
  clientName: string;
  hasSessions: boolean;
}) {
  const [brief, setBrief] = useState<string | null>(null);
  const [briefDate, setBriefDate] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/clients/${clientId}/prep-brief`)
      .then((r) => r.json())
      .then((data) => {
        if (data.brief) {
          setBrief(data.brief.content);
          setBriefDate(data.brief.createdAt);
        }
        setLoaded(true);
      });
  }, [clientId]);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const resp = await fetch(`/api/clients/${clientId}/prep-brief`, {
        method: "POST",
      });
      const data = await resp.json();
      if (resp.ok) {
        setBrief(data.brief.content);
        setBriefDate(data.brief.createdAt);
      } else {
        alert(data.error || "Failed to generate brief");
      }
    } finally {
      setGenerating(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-xl text-foreground">Prep Brief</h2>
        {hasSessions && (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {generating ? "Generating..." : brief ? "Regenerate" : "Generate Brief"}
          </button>
        )}
      </div>

      {brief ? (
        <div className="bg-surface border border-border border-l-3 border-l-accent rounded-r-[var(--radius-md)] p-5">
          <div className="prose prose-sm max-w-none text-foreground text-sm leading-relaxed whitespace-pre-line [&_strong]:font-semibold [&_strong]:text-foreground">
            {brief}
          </div>
          {briefDate && (
            <p className="text-xs text-muted mt-4">
              Generated{" "}
              {new Date(briefDate).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
      ) : hasSessions ? (
        <p className="text-sm text-muted">
          Click &quot;Generate Brief&quot; to create an AI-powered prep brief from{" "}
          {clientName.split(" ")[0]}&apos;s recent sessions.
        </p>
      ) : (
        <p className="text-sm text-muted">
          Prep briefs are generated from session history. No sessions recorded yet.
        </p>
      )}
    </div>
  );
}

function MetaStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{label}</p>
      <p className={`font-mono text-sm font-medium ${accent ? "text-accent" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

function BillingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-border last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-mono text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

function NlmSyncButton({ clientId, clientName, notebookId }: { clientId: string; clientName: string; notebookId: string | null }) {
  const [extensionReady, setExtensionReady] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Detect extension
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.type === "COACHIQ_NLM_EXTENSION_READY") {
        setExtensionReady(true);
      }
      if (event.data?.type === "COACHIQ_NLM_SYNC_RESULT") {
        handleSyncResult(event.data.payload);
      }
    }
    window.addEventListener("message", onMessage);

    // Extension may have already fired ready before this listener — ping it
    const timeout = setTimeout(() => setLoaded(true), 2000);

    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timeout);
    };
  }, []);

  // Mark loaded once extension detected
  useEffect(() => {
    if (extensionReady) setLoaded(true);
  }, [extensionReady]);

  // Fetch pending count
  useEffect(() => {
    fetch(`/api/nlm-sync/pending?clientId=${clientId}`)
      .then((r) => r.json())
      .then((data) => setPendingCount(data.totalPending || 0))
      .catch(() => {});
  }, [clientId]);

  async function handleSync() {
    setSyncing(true);
    setSyncStatus("Fetching pending sessions...");
    try {
      const resp = await fetch(`/api/nlm-sync/pending?clientId=${clientId}`);
      const data = await resp.json();

      if (data.totalPending === 0) {
        setSyncStatus("All sessions already synced");
        setTimeout(() => setSyncStatus(null), 3000);
        setSyncing(false);
        return;
      }

      setSyncStatus(`Syncing ${data.totalPending} session${data.totalPending > 1 ? "s" : ""}...`);

      // Send to extension via postMessage
      window.postMessage({
        type: "COACHIQ_NLM_SYNC",
        payload: { clients: data.clients },
      }, "*");
    } catch {
      setSyncStatus("Failed to fetch pending sessions");
      setSyncing(false);
    }
  }

  async function handleSyncResult(payload: { success: boolean; results?: Array<{ sessionId: string; clientId: string; success: boolean; notebookId?: string; error?: string }>; summary?: { succeeded: number; failed: number }; error?: string }) {
    if (!payload.success) {
      setSyncStatus(payload.error || "Sync failed");
      setSyncing(false);
      return;
    }

    // Report results to the API
    try {
      await fetch("/api/nlm-sync/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: payload.results }),
      });
    } catch {
      // Non-fatal — sessions were still injected into NLM
    }

    const { succeeded, failed } = payload.summary || { succeeded: 0, failed: 0 };
    setSyncStatus(
      failed > 0
        ? `Synced ${succeeded}, ${failed} failed`
        : `Synced ${succeeded} session${succeeded > 1 ? "s" : ""}`
    );
    setPendingCount((prev) => Math.max(0, prev - (succeeded || 0)));
    setSyncing(false);
    setTimeout(() => setSyncStatus(null), 5000);
  }

  if (!loaded) return null;

  if (!extensionReady) {
    return (
      <span
        className="flex items-center gap-2 px-4 py-2 bg-surface border border-border text-muted text-sm font-medium rounded cursor-default"
        title="Install the CoachIQ NLM Sync extension to enable syncing"
      >
        <SyncIcon className="w-4 h-4" />
        NLM Extension required
      </span>
    );
  }

  if (pendingCount === 0 && !syncing && !syncStatus) {
    return (
      <span className="flex items-center gap-2 px-4 py-2 bg-surface border border-green-600/30 text-green-600 text-sm font-medium rounded cursor-default">
        <CheckIcon className="w-4 h-4" />
        NLM synced
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded hover:bg-amber-700 transition-colors disabled:opacity-50"
      >
        <SyncIcon className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
        {syncing ? "Syncing..." : `Sync ${pendingCount} to NLM`}
      </button>
      {syncStatus && (
        <span className="text-xs text-muted">{syncStatus}</span>
      )}
    </div>
  );
}

function SyncIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  );
}

function NotebookIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
    </svg>
  );
}
