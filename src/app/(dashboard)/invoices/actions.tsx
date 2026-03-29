"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function GenerateInvoicesButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    try {
      const resp = await fetch("/api/invoices/generate", { method: "POST" });
      const data = await resp.json();
      if (data.created > 0) {
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleGenerate}
      disabled={loading}
      className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
    >
      {loading ? "Generating..." : "Generate Draft Invoices"}
    </button>
  );
}

interface LineItem {
  date: string;
  description: string;
  hours: number;
  rate: number;
  amount: number;
  timeEntryId?: string;
}

export function InvoiceCard({
  invoice,
  clientName,
  clientId,
}: {
  invoice: {
    id: string;
    invoiceNumber: string;
    periodStart: string;
    periodEnd: string;
    lineItems: LineItem[];
    total: number;
    notes: string | null;
  };
  clientName: string;
  clientId: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<LineItem[]>(invoice.lineItems);
  const [notes, setNotes] = useState(invoice.notes || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const total = items.reduce((sum, item) => sum + item.amount, 0);

  function updateItem(index: number, field: keyof LineItem, value: string) {
    const updated = [...items];
    const item = { ...updated[index] };

    if (field === "hours") {
      item.hours = parseFloat(value) || 0;
      item.amount = item.hours * item.rate;
    } else if (field === "rate") {
      item.rate = parseFloat(value) || 0;
      item.amount = item.hours * item.rate;
    } else if (field === "amount") {
      item.amount = parseFloat(value) || 0;
    } else if (field === "description") {
      item.description = value;
    }

    updated[index] = item;
    setItems(updated);
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineItems: items, notes: notes || null }),
      });
      setEditing(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete invoice ${invoice.invoiceNumber}? Time entries will return to unbilled.`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/invoices/${invoice.id}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  async function handleApprove() {
    setApproving(true);
    try {
      await fetch(`/api/invoices/${invoice.id}/approve`, { method: "POST" });
      router.refresh();
    } finally {
      setApproving(false);
    }
  }

  async function handleSend() {
    if (!confirm(`Send invoice ${invoice.invoiceNumber} to ${clientName} via Stripe? They will receive an email with a payment link.`)) return;
    setSending(true);
    try {
      const resp = await fetch(`/api/invoices/${invoice.id}/send`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok) {
        setSent(true);
        router.refresh();
      } else {
        alert(`Failed to send: ${data.error}`);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
      <div className="flex items-start justify-between">
        <div>
          <a
            href={`/clients/${clientId}`}
            className="font-display text-lg text-foreground hover:text-accent transition-colors"
          >
            {clientName}
          </a>
          <p className="font-mono text-xs text-muted mt-1">
            {invoice.invoiceNumber} ·{" "}
            {new Date(invoice.periodStart).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}{" "}
            –{" "}
            {new Date(invoice.periodEnd).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xl font-medium text-foreground">
            ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-muted mt-0.5">
            {items.length} session{items.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Line items */}
      <div className="mt-4 border-t border-border pt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="text-left pb-2 font-medium">Date</th>
              <th className="text-left pb-2 font-medium">Session</th>
              <th className="text-right pb-2 font-medium">Hours</th>
              <th className="text-right pb-2 font-medium">Rate</th>
              <th className="text-right pb-2 font-medium">Amount</th>
              {editing && <th className="w-8 pb-2"></th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className="border-t border-border/50">
                <td className="py-2 font-mono text-xs text-muted">
                  {new Date(item.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </td>
                <td className="py-2 text-foreground">
                  {editing ? (
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => updateItem(i, "description", e.target.value)}
                      className="w-full bg-background border border-border rounded px-2 py-1 text-sm outline-none focus:border-accent"
                    />
                  ) : (
                    item.description
                  )}
                </td>
                <td className="py-2 font-mono text-right text-muted">
                  {editing ? (
                    <input
                      type="number"
                      step="0.25"
                      value={item.hours}
                      onChange={(e) => updateItem(i, "hours", e.target.value)}
                      className="w-16 bg-background border border-border rounded px-2 py-1 text-sm text-right outline-none focus:border-accent font-mono"
                    />
                  ) : (
                    item.hours.toFixed(2)
                  )}
                </td>
                <td className="py-2 font-mono text-right text-muted">
                  {editing ? (
                    <input
                      type="number"
                      value={item.rate}
                      onChange={(e) => updateItem(i, "rate", e.target.value)}
                      className="w-20 bg-background border border-border rounded px-2 py-1 text-sm text-right outline-none focus:border-accent font-mono"
                    />
                  ) : (
                    `$${item.rate}`
                  )}
                </td>
                <td className="py-2 font-mono text-right text-foreground font-medium">
                  ${item.amount.toFixed(2)}
                </td>
                {editing && (
                  <td className="py-2 pl-2">
                    <button
                      onClick={() => removeItem(i)}
                      className="text-muted hover:text-error transition-colors"
                      title="Remove line item"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td colSpan={editing ? 4 : 4} className="py-2 text-right text-sm text-muted">
                Total
              </td>
              <td className="py-2 font-mono text-right text-foreground">
                ${total.toFixed(2)}
              </td>
              {editing && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Notes */}
      {editing && (
        <div className="mt-3">
          <label className="text-xs text-muted font-medium">Invoice Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add a note for the client..."
            rows={2}
            className="mt-1 w-full bg-background border border-border rounded px-3 py-2 text-sm outline-none focus:border-accent resize-none"
          />
        </div>
      )}

      {notes && !editing && (
        <p className="mt-3 text-xs text-muted italic">Note: {notes}</p>
      )}

      {/* Actions */}
      <div className="mt-4 pt-3 border-t border-border flex gap-2 justify-between">
        <div className="flex gap-2">
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
                onClick={() => {
                  setItems(invoice.lineItems);
                  setNotes(invoice.notes || "");
                  setEditing(false);
                }}
                className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent hover:text-accent transition-colors"
            >
              Edit
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-2 border border-border text-muted text-sm font-medium rounded hover:border-error hover:text-error transition-colors disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
        {!editing && (
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              disabled={approving}
              className="px-4 py-2 border border-border text-foreground text-sm font-medium rounded hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            >
              {approving ? "Approving..." : "Approve"}
            </button>
            <button
              onClick={handleSend}
              disabled={sending || sent}
              className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {sent ? "Sent!" : sending ? "Sending..." : "Send via Stripe"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
