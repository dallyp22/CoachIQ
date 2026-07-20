"use client";

import { useEffect, useState } from "react";
import { Modal, Field, FieldGroup, inputClass } from "@/components/modal";

/**
 * Coaches management — OWNER/ADMIN only.
 *
 * Read as a status board first, a roster second. Adding a coach touches Clerk
 * and Fathom, either of which can fail, and a half-provisioned coach looks
 * completely normal in a plain list. So each row leads with a single verdict —
 * either the one thing that needs a human, or a quiet "ready" — rather than a
 * row of equal-weight chips where nothing wins.
 */

type Coach = {
  id: string;
  name: string;
  loginEmail: string;
  role: "OWNER" | "ADMIN" | "COACH";
  status: "INVITED" | "ACTIVE" | "INACTIVE";
  inviteStatus: "PENDING" | "OK" | "FAILED";
  fathomStatus: "PENDING" | "OK" | "FAILED";
  hasSignedIn: boolean;
  calendarConfigured: boolean;
  fathomConnected: boolean;
  clientCount: number;
};

const ROLE_LABEL: Record<Coach["role"], string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  COACH: "Coach",
};

/**
 * The single most important thing about this coach right now.
 *
 * Ordered by what blocks the coach from working: a failure they cannot fix
 * themselves, then a missing integration, then merely waiting on them.
 */
function verdict(c: Coach): { tone: "error" | "warning" | "quiet"; text: string; retry: boolean } {
  if (c.status === "INACTIVE") {
    return { tone: "quiet", text: "Deactivated", retry: false };
  }
  if (c.inviteStatus === "FAILED") {
    return { tone: "error", text: "Invitation could not be sent", retry: true };
  }
  if (c.fathomStatus === "FAILED") {
    return { tone: "error", text: "Fathom connection failed", retry: true };
  }
  // An admin has no recordings or calendar of their own to connect.
  const needsIntegrations = c.role === "COACH";
  if (needsIntegrations && !c.fathomConnected) {
    return { tone: "warning", text: "Fathom not connected — recordings won't arrive", retry: false };
  }
  if (needsIntegrations && !c.calendarConfigured) {
    return { tone: "warning", text: "No calendar — sessions won't sync", retry: false };
  }
  if (!c.hasSignedIn) {
    return { tone: "quiet", text: "Invited, hasn't signed in yet", retry: false };
  }
  return { tone: "quiet", text: "Ready", retry: false };
}

const TONE_CLASS = {
  error: "text-error",
  warning: "text-warning",
  quiet: "text-muted",
} as const;

export function CoachesSection({ viewerRole }: { viewerRole: "OWNER" | "ADMIN" | "COACH" }) {
  const [coaches, setCoaches] = useState<Coach[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  async function load() {
    try {
      const resp = await fetch("/api/coaches");
      if (!resp.ok) {
        setError("Could not load coaches. Refresh to try again.");
        return;
      }
      setError(null);
      setCoaches((await resp.json()).coaches);
    } catch {
      setError("Could not load coaches. Refresh to try again.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function retry(id: string) {
    setRetrying(id);
    try {
      await fetch(`/api/coaches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retry: true }),
      });
      await load();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h2 className="font-display text-xl text-foreground">Coaches</h2>
        <button
          onClick={() => setAdding(true)}
          className="shrink-0 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
        >
          Add coach
        </button>
      </div>
      <p className="text-sm text-muted mb-5">
        Everyone with an account. A coach sees only their own clients; admins see the whole
        practice.
      </p>

      {/* Async status is announced, not just shown — a screen reader gets no
          repaint notification otherwise. */}
      <div aria-live="polite" aria-busy={coaches === null && !error}>
        {error && <p className="text-sm text-error">{error}</p>}

        {!coaches && !error && <p className="text-sm text-muted">Loading coaches…</p>}

        {coaches?.length === 0 && (
          <div className="text-center py-10 border-t border-border">
            <p className="text-sm text-foreground">No coaches yet</p>
            <p className="text-sm text-muted mt-1 max-w-sm mx-auto">
              Add a coach to give them an account, connect their Fathom recordings, and start
              capturing their sessions.
            </p>
          </div>
        )}

        {coaches && coaches.length > 0 && (
          <ul className="divide-y divide-border border-t border-border">
            {coaches.map((c) => {
              const v = verdict(c);
              const isRetrying = retrying === c.id;
              return (
                <li key={c.id} className="py-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-foreground font-medium">{c.name}</span>
                      <span className="text-[11px] text-muted">{ROLE_LABEL[c.role]}</span>
                    </div>
                    {/* break-all so a long address wraps instead of pushing the
                        Retry button off a narrow screen. */}
                    <p className="font-mono text-xs text-muted mt-0.5 break-all">{c.loginEmail}</p>
                    <p className={`text-sm mt-1.5 ${TONE_CLASS[v.tone]}`}>{v.text}</p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="font-mono text-xs text-muted">
                      {c.clientCount} client{c.clientCount === 1 ? "" : "s"}
                    </p>
                    {v.retry && (
                      <button
                        onClick={() => retry(c.id)}
                        disabled={isRetrying}
                        className="mt-2 min-h-11 px-3 border border-border text-sm rounded hover:bg-background transition-colors disabled:opacity-50"
                      >
                        {isRetrying ? "Retrying…" : "Retry"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {adding && (
        <AddCoachModal
          canGrantAdmin={viewerRole === "OWNER"}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function AddCoachModal({
  canGrantAdmin,
  onClose,
  onAdded,
}: {
  canGrantAdmin: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    loginEmail: "",
    workEmails: "",
    role: "COACH",
    fathomApiKey: "",
    fathomWebhookSecret: "",
    googleCalendarId: "",
    driveRootFolderId: "",
    defaultHourlyRate: "",
    coachingTitleFilter: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; outstanding: string[] } | null>(null);

  function set(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const resp = await fetch("/api/coaches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          workEmails: form.workEmails
            .split(/[,\s]+/)
            .map((e) => e.trim())
            .filter(Boolean),
          defaultHourlyRate: form.defaultHourlyRate || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.error || "Could not add the coach.");
        return;
      }
      setDone({ name: data.name, outstanding: data.outstanding ?? [] });
    } catch {
      setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // What is live, and what still needs a human. Mirrors the onboarding
  // checklist so no step that used to be manual quietly disappears.
  if (done) {
    return (
      <Modal title={`${done.name} added`} onClose={onAdded}>
        {done.outstanding.length === 0 ? (
          <p className="text-sm text-muted">
            Their account is fully set up. They&apos;ll get an email invitation to sign in.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted mb-3">
              Their account exists and the invitation is on its way. Still to do:
            </p>
            <ul className="space-y-2 mb-4">
              {done.outstanding.map((item, i) => (
                <li key={i} className="text-sm text-foreground flex gap-2">
                  <span className="text-accent" aria-hidden="true">
                    •
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-sm text-muted mt-4">
          Next: add their clients from the Clients page so their recordings have someone to
          match against.
        </p>
        <button
          onClick={onAdded}
          className="mt-4 min-h-11 px-5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
        >
          Done
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="Add coach" onClose={onClose}>
      <p className="text-sm text-muted mb-4">
        Creates their account, emails an invitation, and connects Fathom if you supply a key.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-3">
          <Field label="Name *">
            <input
              required
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Login email *" hint="Where the invitation goes.">
            <input
              required
              type="email"
              value={form.loginEmail}
              onChange={(e) => set("loginEmail", e.target.value)}
              className={inputClass}
            />
          </Field>

          {canGrantAdmin && (
            <Field
              label="Role"
              hint="Admins see the whole practice. Coaches see only their own clients."
            >
              <select
                value={form.role}
                onChange={(e) => set("role", e.target.value)}
                className={inputClass}
              >
                <option value="COACH">Coach</option>
                <option value="ADMIN">Admin</option>
              </select>
            </Field>
          )}
        </div>

        <FieldGroup title="Connect their tools">
          <Field
            label="Recording emails"
            hint="Addresses they record and schedule under, if different from their login. Comma separated."
          >
            <input
              value={form.workEmails}
              onChange={(e) => set("workEmails", e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field
            label="Fathom API key"
            hint="With it we register their webhook automatically. Without it, you'll add the webhook manually in Fathom and paste the signing secret below."
          >
            <input
              type="password"
              value={form.fathomApiKey}
              onChange={(e) => set("fathomApiKey", e.target.value)}
              className={inputClass}
            />
          </Field>

          {/* The manual recovery path. outstandingActions tells the admin to
              paste a signing secret; without this field that instruction had
              nowhere to go, and fixing a webhook outage meant raw SQL. */}
          <Field
            label="Fathom webhook signing secret"
            hint="Only needed if you set the webhook up by hand in Fathom. Starts with whsec_."
          >
            <input
              type="password"
              value={form.fathomWebhookSecret}
              onChange={(e) => set("fathomWebhookSecret", e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field
            label="Google Calendar ID"
            hint="They share their coaching calendar with coachiq-pipeline@coachiq-491616.iam.gserviceaccount.com, then paste the calendar ID here."
          >
            <input
              value={form.googleCalendarId}
              onChange={(e) => set("googleCalendarId", e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field
            label="Drive folder ID"
            hint="A folder in their own Drive, shared with edit access. Transcripts land here."
          >
            <input
              value={form.driveRootFolderId}
              onChange={(e) => set("driveRootFolderId", e.target.value)}
              className={inputClass}
            />
          </Field>
        </FieldGroup>

        <FieldGroup title="Defaults">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hourly rate">
              <input
                inputMode="decimal"
                placeholder="300"
                value={form.defaultHourlyRate}
                onChange={(e) => set("defaultHourlyRate", e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Session title filter" hint="Blank uses the practice default.">
              <input
                value={form.coachingTitleFilter}
                onChange={(e) => set("coachingTitleFilter", e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        </FieldGroup>

        {err && (
          <p role="alert" className="text-sm text-error">
            {err}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={saving}
            className="min-h-11 px-5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add coach"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-5 border border-border text-sm rounded hover:bg-background transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
