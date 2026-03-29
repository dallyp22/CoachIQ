import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getOpenAIKey } from "@/lib/ai";

/**
 * Generate a pre-session prep brief for a client.
 *
 * Uses the last 5 session synopses + semantically relevant transcript
 * excerpts to create a structured brief Todd can review before a session.
 *
 * POST /api/clients/[id]/prep-brief
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      sessions: {
        where: { synopsis: { not: null } },
        orderBy: { date: "desc" },
        take: 5,
        select: { date: true, title: true, synopsis: true, actionItems: true },
      },
    },
  });

  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  if (client.sessions.length === 0) {
    return NextResponse.json(
      { error: "No sessions with synopses available to generate a brief" },
      { status: 400 }
    );
  }

  try {
    const apiKey = await getOpenAIKey();

    // Build context from recent synopses
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

    // Store the brief
    const brief = await prisma.prepBrief.create({
      data: {
        clientId: id,
        targetSessionDate: new Date(), // Manual trigger, no specific target
        content: briefContent,
        contextSessions: client.sessions.map((s) => s.date.toISOString()),
      },
    });

    return NextResponse.json({ status: "generated", brief });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate brief";
    console.error("Prep brief error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/clients/[id]/prep-brief — get the latest prep brief
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const brief = await prisma.prepBrief.findFirst({
    where: { clientId: id },
    orderBy: { createdAt: "desc" },
  });

  if (!brief) {
    return NextResponse.json({ brief: null });
  }

  return NextResponse.json({ brief });
}
