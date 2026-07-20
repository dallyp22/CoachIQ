"use client";

import { useEffect, useState } from "react";

/**
 * Coaches management — OWNER/ADMIN only.
 *
 * The list is a status board first and a roster second: adding a coach touches
 * Clerk and Fathom, either of which can fail, and a half-provisioned coach
 * looks completely normal unless the failure is on screen. Each row shows what
 * is actually live, and offers Retry where it isn't.
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

function Chip({
  tone,
  children,
}: {
  tone: "ok" | "pending" | "failed" | "neutral";
  children: React.ReactNode;
}) {
  const tones = {
    ok: "bg-[#16A34A]/10 text-[#15803D]",
    pending: "bg-[#CA8A04]/10 text-[#A16207]",
    failed: "bg-[#DC2626]/10 text-[#B91C1C]",
    neutral: "bg-border/60 text-muted",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function CoachesSection({ viewerRole }: { viewerRole: "OWNER" | "ADMIN" | "COACH" }) {
  const [coaches, setCoaches] = useState<Coach[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const resp = await fetch("/api/coaches");
      if (!resp.ok) {
        setError("Could not load coaches.");
        return;
      }
      setCoaches((await resp.json()).coaches);
    } catch {
      setError("Could not load coaches.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function retry(id: string) {
    await fetch(`/api/coaches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retry: true }),
    });
    load();
  }

  return (
    <section className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="font-display text-xl text-foreground">Coaches</h2>
        <button
          onClick={() => setAdding(true)}
          className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
        >
          Add coach
        </button>
      </div>
      <p className="text-sm text-muted mb-5">
        Everyone with an account. A coach sees only their own clients; admins see the whole practice.
      </p>

      {error && <p className="text-sm text-[#B91C1C]">{error}</p>}
      {!coaches && !error && <p className="text-sm text-muted">Loading…</p>}

      {coaches && coaches.length > 0 && (
        <div className="divide-y divide-border border-t border-border">
          {coaches.map((c) => {
            const needsAttention = c.inviteStatus === "FAILED" || c.fathomStatus === "FAILED";
            return (
              <div key={c.id} className="py-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-foreground font-medium">{c.name}</span>
                    <Chip tone="neutral">{ROLE_LABEL[c.role]}</Chip>
                    {c.status === "INACTIVE" && <Chip tone="failed">Deactivated</Chip>}
                  </div>
                  <p className="font-mono text-xs text-muted mt-1">{c.loginEmail}</p>

                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {c.hasSignedIn ? (
                      <Chip tone="ok">Signed in</Chip>
                    ) : c.inviteStatus === "FAILED" ? (
                      <Chip tone="failed">Invite failed</Chip>
                    ) : (
                      <Chip tone="pending">Invited</Chip>
                    )}

                    {c.fathomConnected ? (
                      <Chip tone="ok">Fathom connected</Chip>
                    ) : c.fathomStatus === "FAILED" ? (
                      <Chip tone="failed">Fathom failed</Chip>
                    ) : (
                      <Chip tone="pending">Fathom manual setup</Chip>
                    )}

                    {c.calendarConfigured ? (
                      <Chip tone="ok">Calendar</Chip>
                    ) : (
                      <Chip tone="pending">No calendar</Chip>
                    )}

                    <span className="font-mono text-xs text-muted">
                      {c.clientCount} client{c.clientCount === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>

                {needsAttention && (
                  <button
                    onClick={() => retry(c.id)}
                    className="shrink-0 px-3 py-1.5 border border-border text-sm rounded hover:bg-background transition-colors"
                  >
                    Retry
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

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
    } finally {
      setSaving(false);
    }
  }

  // Success screen: what is live, and what still needs a human. Mirrors the
  // onboarding checklist so no manual step quietly disappears.
  if (done) {
    return (
      <Modal onClose={onAdded}>
        <h2 className="font-display text-xl text-foreground mb-2">{done.name} added</h2>
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
                  <span className="text-accent">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          onClick={onAdded}
          className="mt-4 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
        >
          Done
        </button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-display text-xl text-foreground mb-1">Add coach</h2>
      <p className="text-sm text-muted mb-4">
        Creates their account, emails an invitation, and connects Fathom if you supply a key.
      </p>

      <form onSubmit={submit} className="space-y-3">
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

        <Field
          label="Recording emails"
          hint="Addresses they record and schedule meetings under, if different from their login. Comma separated."
        >
          <input
            value={form.workEmails}
            onChange={(e) => set("workEmails", e.target.value)}
            className={inputClass}
          />
        </Field>

        {canGrantAdmin && (
          <Field label="Role" hint="Admins see the whole practice. Coaches see only their own clients.">
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

        <Field
          label="Fathom API key"
          hint="Optional. With it we register their webhook automatically; without it you'll add it manually in Fathom."
        >
          <input
            type="password"
            value={form.fathomApiKey}
            onChange={(e) => set("fathomApiKey", e.target.value)}
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

        <div className="grid grid-cols-2 gap-3">
          <Field label="Default hourly rate">
            <input
              inputMode="decimal"
              placeholder="300"
              value={form.defaultHourlyRate}
              onChange={(e) => set("defaultHourlyRate", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Session title filter" hint="Leave blank for the practice default.">
            <input
              value={form.coachingTitleFilter}
              onChange={(e) => set("coachingTitleFilter", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        {err && <p className="text-sm text-[#B91C1C]">{err}</p>}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add coach"}
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
