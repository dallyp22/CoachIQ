/**
 * Renders the structured day brief returned by /api/daily-brief.
 * The API uses OpenAI strict json_schema, so the shape is guaranteed.
 */

export interface DayBriefData {
  schedule: { time: string; description: string }[];
  scheduleNote: string | null;
  perClient: {
    name: string;
    context: string;
    openingQuestion: string | null;
    actionItems?: string[];
  }[];
  summary: string;
}

export function DayBrief({ brief }: { brief: DayBriefData }) {
  const hasSchedule = brief.schedule.length > 0;
  const hasPerClient = brief.perClient.length > 0;

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg,12px)] overflow-hidden">
      <div className="border-l-2 border-accent">
        <div className="px-6 py-5 space-y-6">
          {hasSchedule && (
            <section>
              <SectionHeading>Today&rsquo;s Schedule</SectionHeading>
              <ol className="mt-3 divide-y divide-border/60 border-y border-border/60">
                {brief.schedule.map((row, i) => (
                  <li
                    key={i}
                    className="flex items-baseline gap-4 py-2.5 first:pt-3 last:pb-3"
                  >
                    <span className="font-mono text-xs text-muted tabular-nums w-20 shrink-0">
                      {row.time}
                    </span>
                    <span className="text-sm text-foreground leading-snug">
                      {row.description}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {brief.scheduleNote && (
            <div className="bg-[var(--accent-light,#FEF3C7)]/60 border-l-2 border-accent rounded-r-md px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-accent font-medium">
                Heads up
              </div>
              <p className="mt-1 text-sm text-foreground leading-relaxed">
                {brief.scheduleNote}
              </p>
            </div>
          )}

          {hasPerClient && (
            <section>
              <SectionHeading>Per-Client Context</SectionHeading>
              <ul className="mt-3 space-y-4">
                {brief.perClient.map((row, i) => (
                  <li key={i} className="border-l border-border pl-4">
                    <div className="font-display text-sm text-foreground tracking-tight">
                      {row.name}
                    </div>
                    <p className="text-sm text-foreground/85 leading-relaxed mt-1">
                      {row.context}
                    </p>
                    {row.actionItems && row.actionItems.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] font-mono uppercase tracking-wider text-accent">
                          Open commitments from last session
                        </div>
                        <ul className="mt-1 space-y-1">
                          {row.actionItems.map((item, j) => (
                            <li
                              key={j}
                              className="text-sm text-foreground/85 leading-relaxed flex gap-2"
                            >
                              <span
                                aria-hidden
                                className="text-muted select-none mt-1 leading-none"
                              >
                                •
                              </span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {row.openingQuestion && (
                      <p className="mt-2 text-sm italic text-foreground/75 leading-relaxed">
                        <span className="not-italic text-[10px] font-mono uppercase tracking-wider text-accent mr-2">
                          Open with
                        </span>
                        &ldquo;{row.openingQuestion}&rdquo;
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {brief.summary && (
            <section>
              <SectionHeading>Day Summary</SectionHeading>
              <p className="mt-2 text-sm text-foreground leading-relaxed">
                {brief.summary}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display text-base text-foreground tracking-tight">
      {children}
    </h3>
  );
}
