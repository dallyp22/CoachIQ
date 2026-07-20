"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Modal, Field, inputClass } from "@/components/modal";

/**
 * The prospect dossier (PRD §6.3).
 *
 * Left: who they are and where they stand. Right: the log — every activity and
 * stage move, newest first. Completing a planned activity immediately offers to
 * plan the next one, which is the nudge that keeps a deliberately manual
 * process alive.
 */

type Stage = { id: string; name: string; terminal: "WON" | "LOST" | null; isHot: boolean };
type Coach = { id: string; name: string };

type Prospect = {
  id: string;
  firstName: string;
  lastName: string;
  company: string | null;
  opportunityType: string;
  needSummary: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  source: string;
  stageId: string;
  stageEnteredAt: string;
  nextActivityAt: string | null;
  lostReason: string | null;
  convertedToClientId: string | null;
  createdAt: string;
  stage: Stage;
  coach: Coach;
  assignedCoachId: string | null;
  assignedCoach: Coach | null;
};

type Activity = {
  id: string;
  kind: string;
  activityAt: string;
  notes: string | null;
  completedAt: string | null;
  owner: Coach | null;
};

type StageChange = { id: string; changedAt: string; from: string | null; to: string };

const OPPORTUNITY_TYPES = [
  { value: "COACHING", label: "Coaching" },
  { value: "FACILITATION", label: "Facilitation" },
  { value: "IMPLEMENTATION", label: "Implementation" },
  { value: "MULTIPLE", label: "Multiple" },
];

export function ProspectDossier({
  prospect,
  activities,
  stageChanges,
  stages,
  coaches,
  convertedClient,
}: {
  prospect: Prospect;
  activities: Activity[];
  stageChanges: StageChange[];
  stages: Stage[];
  coaches: Coach[];
  convertedClient: { id: string; name: string } | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<Stage | null>(null);
  const [converting, setConverting] = useState(false);
  const [planAfter, setPlanAfter] = useState(false);

  const name = `${prospect.firstName} ${prospect.lastName}`.trim();
  const closed = Boolean(prospect.stage.terminal);

  async function moveStage(stage: Stage, lostReason?: string) {
    // A lost move needs a reason, so it routes through a prompt rather than
    // firing on select and failing with a 400 the user cannot see.
    if (stage.terminal === "LOST" && !lostReason) {
      setLostFor(stage);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const resp = await fetch(`/api/pipeline/prospects/${prospect.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: stage.id, lostReason }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.error ?? "Could not move this prospect.");
        return;
      }
      setLostFor(null);
      // Offer Convert rather than doing it: it may need an email we don't have,
      // and a stage move should never silently create a billable record.
      if (data.convertAvailable) setConverting(true);
      router.refresh();
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="font-display text-[32px] text-foreground leading-tight">{name}</h1>
          <p className="text-sm text-muted mt-1">
            {prospect.company || "No company"} · {titleCase(prospect.opportunityType)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {closed && !prospect.convertedToClientId && prospect.stage.terminal === "WON" && (
            <button
              onClick={() => setConverting(true)}
              className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
            >
              Convert to client
            </button>
          )}
          {convertedClient && (
            <Link
              href={`/clients/${convertedClient.id}`}
              className="px-4 py-2 border border-border text-sm text-foreground rounded hover:border-accent transition-colors"
            >
              Open client record
            </Link>
          )}
        </div>
      </div>

      {err && (
        <p className="text-sm text-error mb-4 px-4 py-2 bg-error/10 border border-error/25 rounded">
          {err}
        </p>
      )}

      <div className="grid lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] gap-6 items-start">
        {/* ─── Left: identity and standing ─── */}
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5 space-y-4">
          <div>
            <label className="text-xs text-muted font-medium block mb-1.5">Stage</label>
            <select
              className={inputClass}
              value={prospect.stageId}
              disabled={busy}
              onChange={(e) => {
                const stage = stages.find((s) => s.id === e.target.value);
                if (stage) moveStage(stage);
              }}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted mt-1">
              In this stage {daysSince(prospect.stageEnteredAt)} days
            </p>
          </div>

          {prospect.lostReason && (
            <div className="px-3 py-2 bg-background border border-border rounded">
              <p className="text-[11px] uppercase tracking-wide text-muted font-medium">
                Lost because
              </p>
              <p className="text-sm text-foreground mt-0.5">{prospect.lostReason}</p>
            </div>
          )}

          <EditableFields prospect={prospect} coaches={coaches} />

          <dl className="space-y-2 pt-3 border-t border-border text-sm">
            <Row label="Owner" value={prospect.coach.name} />
            <Row label="Assigned" value={prospect.assignedCoach?.name ?? "Unassigned"} />
            <Row label="Added" value={formatDate(prospect.createdAt)} mono />
            <Row label="Source" value={titleCase(prospect.source.replace("_", " "))} />
          </dl>
        </div>

        {/* ─── Right: the log ─── */}
        <div className="space-y-4">
          <ActivityComposer
            prospectId={prospect.id}
            coaches={coaches}
            closed={closed}
            onDone={() => router.refresh()}
          />

          <Timeline
            activities={activities}
            stageChanges={stageChanges}
            onChanged={() => router.refresh()}
            onCompleted={() => setPlanAfter(true)}
          />
        </div>
      </div>

      {lostFor && (
        <LostReasonModal
          stageName={lostFor.name}
          busy={busy}
          onCancel={() => setLostFor(null)}
          onConfirm={(reason) => moveStage(lostFor, reason)}
        />
      )}

      {converting && (
        <ConvertModal
          prospect={prospect}
          onClose={() => setConverting(false)}
          onDone={() => {
            setConverting(false);
            router.refresh();
          }}
        />
      )}

      {planAfter && (
        <PlanNextModal
          prospectId={prospect.id}
          coaches={coaches}
          onClose={() => setPlanAfter(false)}
          onDone={() => {
            setPlanAfter(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

// ─── Identity fields ──────────────────────────────────

function EditableFields({ prospect, coaches }: { prospect: Prospect; coaches: Coach[] }) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);

  async function save(field: string, value: string | null) {
    setSaving(field);
    try {
      await fetch(`/api/pipeline/prospects/${prospect.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      router.refresh();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="What do they need?">
        <textarea
          className={`${inputClass} min-h-[64px] resize-y`}
          defaultValue={prospect.needSummary ?? ""}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (prospect.needSummary ?? "")) save("needSummary", v || null);
          }}
        />
      </Field>

      <Field
        label="Email"
        hint={prospect.email ? undefined : "Needed to convert them to a client."}
      >
        <input
          type="email"
          className={inputClass}
          defaultValue={prospect.email ?? ""}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (prospect.email ?? "")) save("email", v || null);
          }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone">
          <input
            className={inputClass}
            defaultValue={prospect.phone ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (prospect.phone ?? "")) save("phone", v || null);
            }}
          />
        </Field>
        <Field label="Opportunity">
          <select
            className={inputClass}
            defaultValue={prospect.opportunityType}
            onChange={(e) => save("opportunityType", e.target.value)}
          >
            {OPPORTUNITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {coaches.length > 1 && (
        <Field label="Assigned coach">
          <select
            className={inputClass}
            defaultValue={prospect.assignedCoachId ?? ""}
            onChange={(e) => save("assignedCoachId", e.target.value || null)}
          >
            <option value="">Unassigned</option>
            {coaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Notes">
        <textarea
          className={`${inputClass} min-h-[64px] resize-y`}
          defaultValue={prospect.notes ?? ""}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (prospect.notes ?? "")) save("notes", v || null);
          }}
        />
      </Field>

      {saving && <p className="text-[11px] text-muted">Saving…</p>}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-foreground text-right ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

// ─── Composer ─────────────────────────────────────────

function ActivityComposer({
  prospectId,
  coaches,
  closed,
  onDone,
}: {
  prospectId: string;
  coaches: Coach[];
  closed: boolean;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<"LOGGED" | "PLANNED">("LOGGED");
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState(today());
  const [ownerId, setOwnerId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const resp = await fetch("/api/pipeline/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospectId,
          kind,
          activityAt: new Date(when).toISOString(),
          notes: notes.trim() || null,
          ...(ownerId ? { ownerId } : {}),
        }),
      });
      if (!resp.ok) {
        setErr((await resp.json()).error ?? "Could not save that.");
        return;
      }
      setNotes("");
      setWhen(today());
      onDone();
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-surface border border-border rounded-[var(--radius-lg)] p-4"
    >
      <div className="flex gap-1 mb-3">
        {(["LOGGED", "PLANNED"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              kind === k
                ? "bg-accent-light text-accent font-medium"
                : "text-muted hover:text-foreground"
            }`}
          >
            {k === "LOGGED" ? "Log what happened" : "Plan what's next"}
          </button>
        ))}
      </div>

      <textarea
        className={`${inputClass} min-h-[60px] resize-y`}
        placeholder={
          kind === "LOGGED"
            ? "Called to follow up on the proposal — wants to bring in their COO."
            : "Send the revised scope and book a follow-up."
        }
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <div className="flex items-end gap-2 mt-3 flex-wrap">
        <div className="flex-1 min-w-[140px]">
          <label className="text-xs text-muted font-medium block mb-1">
            {kind === "LOGGED" ? "When it happened" : "When"}
          </label>
          <input
            type="date"
            className={inputClass}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        {coaches.length > 1 && (
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-muted font-medium block mb-1">Owner</label>
            <select
              className={inputClass}
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
            >
              <option value="">Me</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : kind === "LOGGED" ? "Log it" : "Plan it"}
        </button>
      </div>

      {closed && kind === "PLANNED" && (
        <p className="text-[11px] text-muted mt-2">
          This prospect is closed — a planned activity here won&apos;t show on the pipeline list.
        </p>
      )}
      {err && <p className="text-sm text-error mt-2">{err}</p>}
    </form>
  );
}

// ─── Timeline ─────────────────────────────────────────

type TimelineEntry =
  | { type: "activity"; at: string; activity: Activity }
  | { type: "stage"; at: string; change: StageChange };

function Timeline({
  activities,
  stageChanges,
  onChanged,
  onCompleted,
}: {
  activities: Activity[];
  stageChanges: StageChange[];
  onChanged: () => void;
  onCompleted: () => void;
}) {
  const entries: TimelineEntry[] = [
    ...activities.map((a) => ({ type: "activity" as const, at: a.activityAt, activity: a })),
    ...stageChanges.map((c) => ({ type: "stage" as const, at: c.changedAt, change: c })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (entries.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-8 text-center">
        <p className="text-sm text-muted">
          Nothing logged yet. Every call, email and meeting you record here becomes the history
          this prospect is judged on.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] divide-y divide-border">
      {entries.map((entry) =>
        entry.type === "activity" ? (
          <ActivityRow
            key={entry.activity.id}
            activity={entry.activity}
            onChanged={onChanged}
            onCompleted={onCompleted}
          />
        ) : (
          <div key={entry.change.id} className="px-4 py-3 flex items-baseline gap-3">
            <span className="font-mono text-xs text-muted w-16 shrink-0">
              {formatDate(entry.change.changedAt)}
            </span>
            <p className="text-sm text-muted">
              {entry.change.from ? (
                <>
                  Moved from <span className="text-foreground">{entry.change.from}</span> to{" "}
                  <span className="text-foreground">{entry.change.to}</span>
                </>
              ) : (
                <>
                  Added to <span className="text-foreground">{entry.change.to}</span>
                </>
              )}
            </p>
          </div>
        )
      )}
    </div>
  );
}

function ActivityRow({
  activity,
  onChanged,
  onCompleted,
}: {
  activity: Activity;
  onChanged: () => void;
  onCompleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isOpenPlan = activity.kind === "PLANNED" && !activity.completedAt;
  const overdue = isOpenPlan && new Date(activity.activityAt) < startOfToday();

  async function complete() {
    setBusy(true);
    try {
      await fetch("/api/pipeline/activities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: activity.id, completed: true }),
      });
      onChanged();
      // Completing one plan is the moment to make the next — the whole cadence
      // depends on never leaving a prospect with nothing scheduled.
      onCompleted();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await fetch(`/api/pipeline/activities?id=${activity.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-3 flex items-baseline gap-3 group">
      <span
        className={`font-mono text-xs w-16 shrink-0 ${overdue ? "text-warning" : "text-muted"}`}
      >
        {formatDate(activity.activityAt)}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${
              isOpenPlan
                ? "bg-accent-light text-accent"
                : "bg-background text-muted border border-border"
            }`}
          >
            {isOpenPlan ? "Planned" : "Logged"}
          </span>
          {activity.owner && <span className="text-xs text-muted">{activity.owner.name}</span>}
          {!activity.owner && <span className="text-xs text-muted">System</span>}
        </div>
        <p className="text-sm text-foreground mt-1 whitespace-pre-wrap break-words">
          {activity.notes || <span className="text-muted">No notes</span>}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {isOpenPlan && (
          <button
            onClick={complete}
            disabled={busy}
            className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
          >
            Mark done
          </button>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="text-xs text-muted hover:text-error transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
          aria-label="Delete this entry"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────

function LostReasonModal({
  stageName,
  busy,
  onCancel,
  onConfirm,
}: {
  stageName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal title={`Move to ${stageName}`} onClose={onCancel}>
      <p className="text-sm text-muted mt-2 mb-4">
        What happened? One line is enough — these add up into the patterns worth knowing.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onConfirm(reason.trim());
        }}
      >
        <input
          className={inputClass}
          placeholder="Went with an internal coach"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !reason.trim()}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {busy ? "Saving…" : "Mark lost"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConvertModal({
  prospect,
  onClose,
  onDone,
}: {
  prospect: Prospect;
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(prospect.email ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; status: string } | null>(
    null
  );

  async function convert(linkToExistingClientId?: string) {
    setBusy(true);
    setErr(null);
    try {
      const resp = await fetch(`/api/pipeline/prospects/${prospect.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), linkToExistingClientId }),
      });
      const data = await resp.json();

      if (resp.status === 409 && data.existingClient) {
        setDuplicate(data.existingClient);
        return;
      }
      if (!resp.ok) {
        setErr(data.message ?? data.error ?? "Could not convert this prospect.");
        return;
      }
      onDone();
      router.push(`/clients/${data.clientId}`);
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (duplicate) {
    return (
      <Modal title="That email already has a client" onClose={onClose}>
        <p className="text-sm text-muted mt-2 leading-relaxed">
          <span className="text-foreground">{duplicate.name}</span> already exists with{" "}
          <span className="font-mono">{email}</span>
          {duplicate.status === "CHURNED" && " (archived)"}. Link this prospect to that record, or
          go back and use a different address.
        </p>
        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={() => setDuplicate(null)}
            className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Use a different email
          </button>
          <button
            onClick={() => convert(duplicate.id)}
            disabled={busy}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {busy ? "Linking…" : `Link to ${duplicate.name}`}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Convert to client" onClose={onClose}>
      <p className="text-sm text-muted mt-2 mb-4 leading-relaxed">
        Creates a client record carrying their name, company and what they need. You&apos;ll land
        on it to set up billing.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          convert();
        }}
      >
        <Field
          label="Email"
          hint="Client records need one — it's how session recordings find the right person."
        >
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </Field>
        {err && <p className="text-sm text-error mt-3">{err}</p>}
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Not yet
          </button>
          <button
            type="submit"
            disabled={busy || !email.includes("@")}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {busy ? "Converting…" : "Create client"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PlanNextModal({
  prospectId,
  coaches,
  onClose,
  onDone,
}: {
  prospectId: string;
  coaches: Coach[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState(inDays(7));
  const [ownerId, setOwnerId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch("/api/pipeline/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospectId,
          kind: "PLANNED",
          activityAt: new Date(when).toISOString(),
          notes: notes.trim() || null,
          ...(ownerId ? { ownerId } : {}),
        }),
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="What's next?" onClose={onClose}>
      <p className="text-sm text-muted mt-2 mb-4 leading-relaxed">
        Nothing is scheduled for this prospect now. Add the next touch while it&apos;s fresh —
        or skip, and they&apos;ll show at the top of the pipeline as unscheduled.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <Field label="What">
          <textarea
            className={`${inputClass} min-h-[60px] resize-y`}
            placeholder="Follow up on the proposal"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="When">
            <input
              type="date"
              className={inputClass}
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </Field>
          {coaches.length > 1 && (
            <Field label="Owner">
              <select
                className={inputClass}
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                <option value="">Me</option>
                {coaches.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {busy ? "Saving…" : "Plan it"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── helpers ──────────────────────────────────────────

function titleCase(v: string) {
  return v.charAt(0) + v.slice(1).toLowerCase();
}
function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function daysSince(d: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function inDays(n: number) {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
