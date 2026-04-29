/**
 * Render the AI-generated day brief with brand-aligned typography.
 *
 * The model is prompted to return three sections in this shape:
 *   **Today's Schedule**     — list of "- **TIME** — DESCRIPTION"
 *   **Note:** ...            — optional callout (or any **Label:** prefix paragraph)
 *   **Per-Client Context**   — list of "- **Name:** sentence(s)"
 *   **Day Summary**          — paragraphs
 *
 * We parse on `**Heading**` lines, then style each block. Inline `**bold**`
 * inside text is converted to <strong>; smart quotes pass through.
 */

interface Block {
  kind: "section";
  title: string;
  body: string[];
}

function parseBrief(raw: string): Block[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let current: Block | null = null;

  const headingRe = /^\s*\*\*([^*][^*]*?)\*\*\s*$/;
  const inlineHeadingRe = /^\s*\*\*([^*][^*]*?):\*\*\s+(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      if (current) current.body.push("");
      continue;
    }

    const block = headingRe.exec(line);
    if (block) {
      current = { kind: "section", title: block[1].trim(), body: [] };
      blocks.push(current);
      continue;
    }

    const inline = inlineHeadingRe.exec(line);
    if (inline && !current) {
      current = { kind: "section", title: inline[1].trim(), body: [inline[2]] };
      blocks.push(current);
      continue;
    }

    if (!current) {
      current = { kind: "section", title: "", body: [] };
      blocks.push(current);
    }
    current.body.push(line);
  }

  // Trim trailing blank lines per block
  for (const b of blocks) {
    while (b.body.length && b.body[b.body.length - 1] === "") b.body.pop();
  }
  return blocks.filter((b) => b.body.length > 0 || b.title);
}

function renderInline(text: string, key: string | number) {
  // Convert **bold** spans to <strong>. Don't try to be a full markdown parser —
  // the AI prompt only emits bold, dashes, and en/em punctuation.
  const parts: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(
      <strong key={`${key}-${i}`} className="font-medium text-foreground">
        {m[1]}
      </strong>
    );
    lastIdx = re.lastIndex;
    i++;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

interface ScheduleRow {
  time: string;
  description: string;
}

function parseScheduleRows(body: string[]): ScheduleRow[] | null {
  const rows: ScheduleRow[] = [];
  for (const line of body) {
    if (!line.trim()) continue;
    // "- **8:00 AM** — Executive Coaching..."
    const m = /^\s*[-•]\s*\*\*([^*]+)\*\*\s*[—–-]\s*(.*)$/.exec(line);
    if (!m) return null;
    rows.push({ time: m[1].trim(), description: m[2].trim() });
  }
  return rows.length > 0 ? rows : null;
}

interface ClientRow {
  name: string;
  text: string;
}

function parseClientRows(body: string[]): ClientRow[] | null {
  const rows: ClientRow[] = [];
  let current: ClientRow | null = null;
  for (const line of body) {
    const m = /^\s*[-•]\s*\*\*([^*]+?):\*\*\s*(.*)$/.exec(line);
    if (m) {
      current = { name: m[1].trim(), text: m[2].trim() };
      rows.push(current);
    } else if (current && line.trim()) {
      current.text += " " + line.trim();
    } else if (!current) {
      return null;
    }
  }
  return rows.length > 0 ? rows : null;
}

function renderParagraphs(body: string[], keyPrefix: string) {
  const paragraphs: string[][] = [[]];
  for (const line of body) {
    if (line === "") {
      if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
    } else {
      paragraphs[paragraphs.length - 1].push(line);
    }
  }
  return paragraphs
    .filter((p) => p.length > 0)
    .map((p, i) => (
      <p key={`${keyPrefix}-${i}`} className="text-sm text-foreground leading-relaxed">
        {renderInline(p.join(" "), `${keyPrefix}-${i}-inline`)}
      </p>
    ));
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display text-base text-foreground tracking-tight">
      {children}
    </h3>
  );
}

function ScheduleBlock({ rows }: { rows: ScheduleRow[] }) {
  return (
    <ol className="mt-3 divide-y divide-border/60 border-y border-border/60">
      {rows.map((r, i) => (
        <li
          key={i}
          className="flex items-baseline gap-4 py-2.5 first:pt-3 last:pb-3"
        >
          <span className="font-mono text-xs text-muted tabular-nums w-20 shrink-0">
            {r.time}
          </span>
          <span className="text-sm text-foreground leading-snug">
            {renderInline(r.description, `sched-${i}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ClientContextBlock({ rows }: { rows: ClientRow[] }) {
  return (
    <ul className="mt-3 space-y-3">
      {rows.map((r, i) => (
        <li key={i}>
          <div className="font-display text-sm text-foreground">{r.name}</div>
          <p className="text-sm text-foreground/85 leading-relaxed mt-0.5">
            {renderInline(r.text, `client-${i}`)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function CalloutBlock({ label, body }: { label: string; body: string[] }) {
  return (
    <div className="mt-3 bg-[var(--accent-light,#FEF3C7)]/60 border-l-2 border-accent rounded-r-md px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-accent font-medium">
        {label}
      </div>
      <div className="mt-1 space-y-2">{renderParagraphs(body, "note")}</div>
    </div>
  );
}

export function DayBrief({ brief }: { brief: string }) {
  const blocks = parseBrief(brief);

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg,12px)] overflow-hidden">
      <div className="border-l-2 border-accent">
        <div className="px-6 py-5 space-y-6">
          {blocks.map((block, i) => {
            const titleLower = block.title.toLowerCase();

            // Inline-bold "Note:" or any one-liner labelled callout
            if (
              titleLower === "note" ||
              titleLower === "heads up" ||
              titleLower === "warning"
            ) {
              return (
                <CalloutBlock
                  key={i}
                  label={block.title}
                  body={block.body}
                />
              );
            }

            // Today's Schedule — render as time/description rows
            if (
              titleLower.includes("schedule") ||
              titleLower.includes("today")
            ) {
              const rows = parseScheduleRows(block.body);
              if (rows) {
                return (
                  <section key={i}>
                    <SectionHeading>{block.title}</SectionHeading>
                    <ScheduleBlock rows={rows} />
                  </section>
                );
              }
            }

            // Per-Client Context — render as named-bullet stack
            if (
              titleLower.includes("per-client") ||
              titleLower.includes("client context") ||
              titleLower.includes("context")
            ) {
              const rows = parseClientRows(block.body);
              if (rows) {
                return (
                  <section key={i}>
                    <SectionHeading>{block.title}</SectionHeading>
                    <ClientContextBlock rows={rows} />
                  </section>
                );
              }
            }

            // Day Summary or anything else — paragraph block
            return (
              <section key={i}>
                {block.title && <SectionHeading>{block.title}</SectionHeading>}
                <div className="mt-2 space-y-2">
                  {renderParagraphs(block.body, `s-${i}`)}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
