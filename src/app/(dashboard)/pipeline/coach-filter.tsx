import Link from "next/link";

/**
 * "All coaches / Todd / Kurt" (PRD §6.1).
 *
 * Practice-wide visibility is the reason an OWNER sees every prospect, and
 * without this control that visibility is all-or-nothing: Todd could see
 * everyone's pipeline but never answer "what is Kurt working on?" The API and
 * the page both accepted a `coach` param already — nothing rendered it, which
 * made the capability real but unreachable.
 *
 * Only shown to OWNER/ADMIN. A COACH is pinned to themselves by scopeCoachId,
 * so for them the control would be a filter with one option that changes
 * nothing.
 */
export function CoachFilter({
  coaches,
  selected,
  basePath,
  extraParams = {},
}: {
  coaches: Array<{ id: string; name: string }>;
  selected: string | null;
  basePath: string;
  extraParams?: Record<string, string | undefined>;
}) {
  const qs = (coachId?: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(extraParams)) if (v) params.set(k, v);
    if (coachId) params.set("coach", coachId);
    const s = params.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-xs text-muted uppercase tracking-wide font-medium mr-1">Coach</span>
      <Link
        href={qs()}
        className={`px-3 py-1.5 text-sm rounded transition-colors ${
          !selected ? "bg-accent-light text-accent font-medium" : "text-muted hover:text-foreground"
        }`}
      >
        All coaches
      </Link>
      {coaches.map((c) => (
        <Link
          key={c.id}
          href={qs(c.id)}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            selected === c.id
              ? "bg-accent-light text-accent font-medium"
              : "text-muted hover:text-foreground"
          }`}
        >
          {c.name}
        </Link>
      ))}
    </div>
  );
}
