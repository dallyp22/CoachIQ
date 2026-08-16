"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Field, inputClass } from "@/components/modal";
import type { FeedbackType } from "@/generated/prisma/enums";

/**
 * File a bug or feature request. Two required fields and nothing else — the
 * environment (page, version, browser) is captured for you on submit, because
 * a report that asks for repro steps up front is a report that never gets
 * filed.
 */
export function ReportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Report
      </button>
      {open && <ReportModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [type, setType] = useState<FeedbackType>("BUG");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setErr("Give it a short title.");
      return;
    }
    if (!body.trim()) {
      setErr(type === "BUG" ? "What happened, and what did you expect?" : "Describe what you'd like it to do.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // The page they came from is the most useful context we can capture for
      // free; it's just a hint, so referrer-or-here is fine.
      const pageUrl = typeof document !== "undefined" ? document.referrer || window.location.href : null;
      const resp = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, title, body, pageUrl }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setErr(data.error || "Could not submit. Try again.");
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Report a bug or request a feature" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 mt-4">
        <div className="flex gap-2">
          {(["BUG", "FEATURE"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex-1 px-4 py-2.5 text-sm font-medium rounded border transition-colors ${
                type === t
                  ? t === "BUG"
                    ? "border-error/40 bg-error/10 text-error"
                    : "border-info/40 bg-info/10 text-info"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {t === "BUG" ? "Something's broken" : "I'd like a feature"}
            </button>
          ))}
        </div>

        <Field label="Title">
          <input
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={type === "BUG" ? "Not all my appointments show up" : "Text reminders before sessions"}
            autoFocus
            maxLength={200}
          />
        </Field>

        <Field
          label={type === "BUG" ? "What happened?" : "What would you like?"}
          hint="We capture the page you were on, your app version, and your browser automatically — no need to include them."
        >
          <textarea
            className={`${inputClass} min-h-[120px] resize-y`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              type === "BUG"
                ? "Monday's 2:30 session is on my Google Calendar but isn't showing in CoachIQ."
                : "A text the morning of each session so clients don't miss them."
            }
            maxLength={5000}
          />
        </Field>

        {err && <p className="text-sm text-error">{err}</p>}

        <div className="flex justify-end gap-2 pt-1">
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
            {saving ? "Submitting…" : "Submit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
