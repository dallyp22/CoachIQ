import Link from "next/link";

/**
 * List ↔ Board switch. Server-rendered Links (not client state) so the view is
 * a real URL — shareable, back-button-friendly, and it survives a refresh.
 */
export function ViewToggle({ view }: { view: "list" | "board" }) {
  return (
    <div className="mt-6 flex gap-1 border-b border-border">
      <Tab href="/feedback?view=list" label="List" active={view === "list"} />
      <Tab href="/feedback?view=board" label="Board" active={view === "board"} />
    </div>
  );
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`-mb-px border-b-2 px-1 py-2.5 text-sm transition-colors ${
        active ? "border-accent font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
