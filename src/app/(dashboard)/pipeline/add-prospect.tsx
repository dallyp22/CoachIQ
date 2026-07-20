"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Field, inputClass } from "@/components/modal";

/**
 * Add prospects — one at a time, or a tracker pasted in.
 *
 * The paste path is the one that matters on day one: Todd already tracks
 * prospects in a document, and the module is worthless to him if it opens
 * empty. Four columns, only the name required — every additional mandatory
 * column in a fixed order is another way the paste fails, and a fiddly import
 * is an import that never happens.
 */

const OPPORTUNITY_TYPES = [
  { value: "COACHING", label: "Coaching" },
  { value: "FACILITATION", label: "Facilitation" },
  { value: "IMPLEMENTATION", label: "Implementation" },
  { value: "MULTIPLE", label: "Multiple" },
];

export type StageOption = { id: string; name: string };
export type CoachOption = { id: string; name: string };

export function AddProspectButton({
  stages,
  coaches,
  label = "Add prospect",
}: {
  stages: StageOption[];
  coaches: CoachOption[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
      >
        {label}
      </button>
      {open && (
        <AddProspectModal stages={stages} coaches={coaches} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

type Failure = { name: string; error: string };
type ParsedRow = { firstName: string; lastName: string; company?: string; needSummary?: string; email?: string };

/**
 * "First Last, Company, What they need, email" per line — the shape of a row
 * someone copies out of a spreadsheet. Tabs and commas both split, so a direct
 * paste from Sheets lands correctly.
 *
 * Only the name is required. Everything else defaults: stage to the first open
 * stage, opportunity type to Coaching, owner to whoever is pasting. They are
 * drafts to refine in the dossier, not final records.
 */
export function parsePasted(text: string): ParsedRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, company, need, email] = line.split(/\t|,/).map((p) => p?.trim() ?? "");
      // Everything before the last space is the first name, so "Mary Jo Smith"
      // keeps "Mary Jo" together rather than losing "Jo".
      const parts = (name ?? "").split(/\s+/).filter(Boolean);
      const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");
      return {
        firstName,
        lastName,
        company: company || undefined,
        needSummary: need || undefined,
        email: email || undefined,
      };
    });
}

function AddProspectModal({
  stages,
  coaches,
  onClose,
}: {
  stages: StageOption[];
  coaches: CoachOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"single" | "paste">("single");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; failed: Failure[] } | null>(null);

  const [single, setSingle] = useState({
    firstName: "",
    lastName: "",
    company: "",
    needSummary: "",
    email: "",
    opportunityType: "COACHING",
    stageId: stages[0]?.id ?? "",
    assignedCoachId: "",
  });
  const [pasted, setPasted] = useState("");

  const preview = mode === "paste" ? parsePasted(pasted) : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const prospects = mode === "single" ? [single] : preview;
      if (prospects.length === 0) {
        setErr("Nothing to add.");
        return;
      }
      if (mode === "single" && !single.firstName.trim() && !single.lastName.trim()) {
        setErr("A name is required.");
        return;
      }

      const resp = await fetch("/api/pipeline/prospects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospects }),
      });
      const data = await resp.json();

      if (!resp.ok && !data.created?.length) {
        setErr(data.error || data.failed?.[0]?.error || "Could not add prospects.");
        return;
      }

      // 207: some landed, some didn't. Show both — discarding the good rows
      // means re-pasting the whole tracker to fix one line.
      setResult({ created: data.created?.length ?? 0, failed: data.failed ?? [] });
      router.refresh();
    } catch {
      setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <Modal
        title={`${result.created} prospect${result.created === 1 ? "" : "s"} added`}
        onClose={onClose}
      >
        {result.failed.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-error mb-2">
              {result.failed.length} row{result.failed.length === 1 ? "" : "s"} could not be added:
            </p>
            <ul className="text-xs text-muted space-y-1 max-h-40 overflow-y-auto">
              {result.failed.map((f, i) => (
                <li key={i}>
                  <span className="text-foreground">{f.name || "(no name)"}</span> — {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add prospect" onClose={onClose}>
      <div className="flex gap-1 mt-4 mb-4 border-b border-border">
        {(["single", "paste"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-3 py-2 text-sm transition-colors border-b-2 -mb-px ${
              mode === m
                ? "border-accent text-foreground font-medium"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {m === "single" ? "One prospect" : "Paste a list"}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === "single" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <input
                  className={inputClass}
                  value={single.firstName}
                  onChange={(e) => setSingle({ ...single, firstName: e.target.value })}
                  autoFocus
                />
              </Field>
              <Field label="Last name">
                <input
                  className={inputClass}
                  value={single.lastName}
                  onChange={(e) => setSingle({ ...single, lastName: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Company">
              <input
                className={inputClass}
                value={single.company}
                onChange={(e) => setSingle({ ...single, company: e.target.value })}
              />
            </Field>

            <Field
              label="What do they need?"
              hint="Carried onto the client record if this becomes a engagement."
            >
              <textarea
                className={`${inputClass} min-h-[64px] resize-y`}
                value={single.needSummary}
                onChange={(e) => setSingle({ ...single, needSummary: e.target.value })}
              />
            </Field>

            <Field
              label="Email"
              hint="Optional now — required to convert them to a client later."
            >
              <input
                type="email"
                className={inputClass}
                value={single.email}
                onChange={(e) => setSingle({ ...single, email: e.target.value })}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Opportunity">
                <select
                  className={inputClass}
                  value={single.opportunityType}
                  onChange={(e) => setSingle({ ...single, opportunityType: e.target.value })}
                >
                  {OPPORTUNITY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Stage">
                <select
                  className={inputClass}
                  value={single.stageId}
                  onChange={(e) => setSingle({ ...single, stageId: e.target.value })}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {coaches.length > 1 && (
              <Field label="Assigned coach" hint="Who owns the next touch. Leave unassigned if nobody has picked it up.">
                <select
                  className={inputClass}
                  value={single.assignedCoachId}
                  onChange={(e) => setSingle({ ...single, assignedCoachId: e.target.value })}
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
          </>
        ) : (
          <>
            <Field
              label="One prospect per line"
              hint="Name, company, what they need, email — commas or tabs. Only the name is required; everything else you can fill in later."
            >
              <textarea
                className={`${inputClass} min-h-[160px] font-mono text-xs resize-y`}
                placeholder={
                  "Dana Whitfield, Northwind Logistics, Wants exec coaching for a new VP, dana@northwind.com\nMarcus Lee, Aperture Health, Team offsite facilitation"
                }
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                autoFocus
              />
            </Field>

            {preview.length > 0 && (
              <div className="border border-border rounded overflow-hidden">
                <div className="px-3 py-2 bg-background border-b border-border">
                  <p className="text-[11px] uppercase tracking-wide text-muted font-medium">
                    {preview.length} row{preview.length === 1 ? "" : "s"} — check before adding
                  </p>
                </div>
                <div className="max-h-44 overflow-y-auto">
                  <table className="w-full text-xs">
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i} className="border-b border-border last:border-b-0">
                          <td className="px-3 py-1.5 text-foreground whitespace-nowrap">
                            {`${row.firstName} ${row.lastName}`.trim() || (
                              <span className="text-error">no name</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-muted">{row.company || "—"}</td>
                          <td className="px-3 py-1.5 text-muted font-mono">{row.email || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <p className="text-[11px] text-muted leading-snug">
              Pasted rows land in <span className="text-foreground">{stages[0]?.name}</span> as
              Coaching opportunities assigned to you. Change any of it in the prospect afterwards.
            </p>
          </>
        )}

        {err && <p className="text-sm text-error">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving
              ? "Adding…"
              : mode === "paste" && preview.length > 0
                ? `Add ${preview.length}`
                : "Add prospect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
