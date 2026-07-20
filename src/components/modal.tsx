"use client";

import { useEffect, useRef, useId } from "react";

/**
 * Accessible modal dialog.
 *
 * Shared rather than copied per surface: the Coaches and Add Client modals
 * each had their own backdrop div, and a keyboard trap fixed in one would
 * have stayed broken in the other.
 *
 * What a mouse user gets for free and a keyboard user does not:
 *   - Escape to close (clicking the backdrop is mouse-only)
 *   - focus moved into the dialog on open, so the next Tab lands inside
 *   - focus kept inside while open, so Tab cannot wander to the page behind
 *   - focus returned to whatever opened it on close, so you are not dumped
 *     at the top of the document
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    // Move focus in, preferring the first field over the panel itself so the
    // user starts where they will actually type.
    const focusables = getFocusable(panelRef.current);
    (focusables[0] ?? panelRef.current)?.focus();

    // The page behind must not scroll while a dialog is over it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const items = getFocusable(panelRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];

      // Wrap at both ends so Tab and Shift+Tab stay inside the dialog.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-surface border border-border rounded-[var(--radius-lg)] p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="font-display text-xl text-foreground mb-1">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

const inputClass =
  "w-full px-3 py-2 border border-border rounded bg-background text-sm text-foreground";

/** Label + optional hint. The label stays visible when the field has content. */
export function Field({
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

/** Groups related fields so a long form reads as a few decisions, not a list of twelve. */
export function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="border-t border-border pt-3">
      <legend className="text-[11px] uppercase tracking-wide text-muted font-medium pr-2">
        {title}
      </legend>
      <div className="space-y-3 mt-1">{children}</div>
    </fieldset>
  );
}

export { inputClass };
