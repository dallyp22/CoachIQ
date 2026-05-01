"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface GroupShape {
  id: string;
  name: string;
  displayName: string | null;
  billingContactName: string | null;
  billingContactEmail: string;
  ccEmails: string[];
  hourlyRate: number | null;
  billingCadence: string;
  customCadenceDays: number | null;
  billingTimezone: string | null;
  billingPausedUntil: string | null;
  retainer: number;
  stripeCustomerId: string | null;
  notes: string | null;
  status: string;
}

interface MemberShape {
  id: string;
  name: string;
  displayName: string | null;
  email: string;
  hourlyRate: number;
  status: string;
}

interface InvoiceShape {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  createdAt: string;
}

interface AvailableClient {
  id: string;
  name: string;
  email: string;
}

export function GroupDetail({
  group: initialGroup,
  members,
  invoices,
  availableClients,
}: {
  group: GroupShape;
  members: MemberShape[];
  invoices: InvoiceShape[];
  availableClients: AvailableClient[];
}) {
  const router = useRouter();
  const [group, setGroup] = useState(initialGroup);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function update<K extends keyof GroupShape>(key: K, value: GroupShape[K]) {
    setGroup({ ...group, [key]: value });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const resp = await fetch(`/api/billing-groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: group.name,
          displayName: group.displayName,
          billingContactName: group.billingContactName,
          billingContactEmail: group.billingContactEmail,
          ccEmails: group.ccEmails,
          hourlyRate: group.hourlyRate,
          billingCadence: group.billingCadence,
          customCadenceDays: group.customCadenceDays,
          billingTimezone: group.billingTimezone,
          notes: group.notes,
        }),
      });
      if (resp.ok) {
        setEditing(false);
        router.refresh();
      } else {
        const data = await resp.json();
        alert(`Save failed: ${data.error}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleAddMember(clientId: string) {
    const resp = await fetch(`/api/billing-groups/${group.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
    if (resp.ok) router.refresh();
    else alert("Failed to add member");
  }

  async function handleRemoveMember(clientId: string) {
    if (!confirm("Remove member from group? Their future invoices will go solo.")) return;
    const resp = await fetch(`/api/billing-groups/${group.id}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
    if (resp.ok) router.refresh();
    else alert("Failed to remove member");
  }

  async function handleDelete() {
    const resp = await fetch(`/api/billing-groups/${group.id}`, { method: "DELETE" });
    const data = await resp.json();
    if (resp.ok) {
      router.push("/billing-groups");
    } else {
      alert(data.error);
      setConfirmDelete(false);
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="font-display text-[32px] text-foreground">{group.displayName ?? group.name}</h1>
          <p className="text-sm text-muted mt-1 font-mono">{group.billingContactEmail}</p>
        </div>
        <div className="flex gap-2">
          {editing ? (
            <>
              <button
                onClick={() => { setGroup(initialGroup); setEditing(false); }}
                className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="px-4 py-2 border border-error/40 text-error text-sm font-medium rounded hover:bg-error/10 transition-colors"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Billing identity */}
      <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5 mb-6">
        <h2 className="font-display text-lg text-foreground mb-4">Billing identity</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Group name" value={group.name} editing={editing} onChange={(v) => update("name", v)} />
          <Field label="Display name" value={group.displayName ?? ""} editing={editing} onChange={(v) => update("displayName", v || null)} placeholder={group.name} />
          <Field label="Contact email" value={group.billingContactEmail} editing={editing} onChange={(v) => update("billingContactEmail", v)} mono />
          <Field label="Contact name" value={group.billingContactName ?? ""} editing={editing} onChange={(v) => update("billingContactName", v || null)} />
          <div>
            <label className="text-xs text-muted font-medium block mb-1.5">Hourly rate override</label>
            <input
              type="number"
              step="0.01"
              disabled={!editing}
              value={group.hourlyRate ?? ""}
              onChange={(e) => update("hourlyRate", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="Leave blank to use each member's rate"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent font-mono disabled:opacity-60"
            />
          </div>
          <div>
            <label className="text-xs text-muted font-medium block mb-1.5">Cadence</label>
            <select
              disabled={!editing}
              value={group.billingCadence}
              onChange={(e) => update("billingCadence", e.target.value)}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
            >
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Biweekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="CUSTOM_DAYS">Custom days</option>
            </select>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted">Retainer:</span>{" "}
            <span className="font-mono text-foreground">${group.retainer.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted">Stripe customer:</span>{" "}
            <span className="font-mono text-xs text-foreground">{group.stripeCustomerId ?? "(none yet)"}</span>
          </div>
        </div>
      </div>

      {/* Members */}
      <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg text-foreground">Members ({members.length})</h2>
          <AddMemberPicker availableClients={availableClients} onAdd={handleAddMember} />
        </div>
        {members.length === 0 ? (
          <p className="text-sm text-muted">No members yet. Add active clients above to roll their hours into this group's invoices.</p>
        ) : (
          <table className="w-full">
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-border/50 last:border-b-0">
                  <td className="py-2 text-sm text-foreground">
                    <Link href={`/clients/${m.id}`} className="hover:text-accent transition-colors">
                      {m.displayName ?? m.name}
                    </Link>
                  </td>
                  <td className="py-2 font-mono text-xs text-muted">{m.email}</td>
                  <td className="py-2 font-mono text-sm text-muted text-right">${m.hourlyRate}/hr</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => handleRemoveMember(m.id)}
                      className="text-xs text-muted hover:text-error transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent invoices */}
      <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
        <h2 className="font-display text-lg text-foreground mb-4">Recent invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted">No invoices yet for this group.</p>
        ) : (
          <table className="w-full">
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="border-b border-border/50 last:border-b-0">
                  <td className="py-2 font-mono text-sm text-muted">{i.invoiceNumber}</td>
                  <td className="py-2 text-sm text-muted">{i.status}</td>
                  <td className="py-2 font-mono text-sm text-foreground text-right">${i.total.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6 w-full max-w-sm">
            <h3 className="font-display text-lg text-foreground mb-2">Delete group?</h3>
            <p className="text-sm text-muted mb-4">
              Members keep their data but go back to solo billing. Refused if any non-void invoices reference this group.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 border border-border text-foreground text-sm rounded hover:border-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-error text-white text-sm rounded hover:opacity-90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label, value, editing, onChange, placeholder, mono,
}: {
  label: string;
  value: string;
  editing: boolean;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-muted font-medium block mb-1.5">{label}</label>
      <input
        disabled={!editing}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60 ${mono ? "font-mono" : ""}`}
      />
    </div>
  );
}

function AddMemberPicker({
  availableClients, onAdd,
}: {
  availableClients: AvailableClient[];
  onAdd: (id: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!pickerOpen) {
    return (
      <button
        onClick={() => setPickerOpen(true)}
        disabled={availableClients.length === 0}
        className="px-3 py-1.5 border border-border text-foreground text-xs font-medium rounded hover:border-accent transition-colors disabled:opacity-50"
      >
        Add member
      </button>
    );
  }

  return (
    <select
      autoFocus
      onChange={(e) => {
        if (e.target.value) {
          onAdd(e.target.value);
          setPickerOpen(false);
        }
      }}
      onBlur={() => setPickerOpen(false)}
      className="bg-background border border-accent rounded px-3 py-1.5 text-xs outline-none"
    >
      <option value="">Pick a client...</option>
      {availableClients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.email})
        </option>
      ))}
    </select>
  );
}
