import { prisma } from "@/lib/db";
import { getOpenAIKey } from "@/lib/ai";

/**
 * Generate a prep brief for a client.
 * Returns the created PrepBrief record.
 */
export async function generatePrepBrief(
  clientId: string,
  targetDate?: Date
) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      sessions: {
        where: { synopsis: { not: null } },
        orderBy: { date: "desc" },
        take: 5,
        select: { id: true, date: true, title: true, synopsis: true, actionItems: true },
      },
    },
  });

  if (!client) throw new Error("Client not found");
  if (client.sessions.length === 0) {
    throw new Error("No sessions with synopses available");
  }

  const apiKey = await getOpenAIKey();

  const synopsesContext = client.sessions
    .map((s) => {
      const date = s.date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const actionItems = s.actionItems as Array<{ description?: string }> | null;
      const aiStr = actionItems?.length
        ? `\nAction items: ${actionItems.map((a) => a.description).join("; ")}`
        : "";
      return `[${date}] ${s.title}\n${s.synopsis}${aiStr}`;
    })
    .join("\n\n");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a coaching intelligence assistant preparing a pre-session brief for executive coach Todd Zimbelman. Generate a structured prep brief that helps Todd walk into his next coaching session fully prepared.

Format the brief with these sections:
**Last Session Recap** — 2-3 sentences summarizing the most recent session
**Open Commitments** — bullet list of action items the client committed to (flag any overdue)
**Patterns to Watch** — 2-3 recurring themes or behavioral patterns across recent sessions
**Suggested Focus Areas** — 2-3 specific topics or questions Todd should explore in the upcoming session

Write in second person ("you discussed...", "consider asking about..."). Be specific and actionable. Use the client's first name. Keep the total brief under 300 words.`,
        },
        {
          role: "user",
          content: `Client: ${client.name}
Company: ${client.company || "Not specified"}
Sessions: ${client.sessionCount} total
Rate: $${client.hourlyRate}/hr
Meeting Cadence: ${client.meetingCadence}

RECENT SESSION HISTORY (most recent first):
${synopsesContext}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 600,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const briefContent = data.choices[0].message.content.trim();

  const brief = await prisma.prepBrief.create({
    data: {
      clientId,
      targetSessionDate: targetDate || new Date(),
      content: briefContent,
      contextSessions: client.sessions.map((s) => s.id),
      delivered: !!targetDate, // Auto-generated briefs are marked delivered
      deliveredAt: targetDate ? new Date() : null,
    },
  });

  return brief;
}
