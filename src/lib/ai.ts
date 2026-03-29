import { prisma } from "@/lib/db";

/**
 * Get the active OpenAI API key.
 * Checks CoachSettings first (Todd's key), falls back to env var.
 */
export async function getOpenAIKey(): Promise<string> {
  const settings = await prisma.coachSettings.findFirst();
  const key = settings?.openaiApiKey || process.env.OPEN_AI_API || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("No OpenAI API key configured");
  return key;
}

/**
 * Get the active Anthropic API key.
 */
export async function getAnthropicKey(): Promise<string> {
  const settings = await prisma.coachSettings.findFirst();
  const key = settings?.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No Anthropic API key configured");
  return key;
}

/**
 * Generate a coaching session synopsis using OpenAI GPT-4o-mini.
 */
export async function generateSynopsis(
  transcript: string,
  clientName: string,
  priorSynopses: string[] = []
): Promise<string> {
  const apiKey = await getOpenAIKey();

  const contextBlock = priorSynopses.length > 0
    ? `\n\nPRIOR SESSION SYNOPSES (most recent first):\n${priorSynopses.map((s, i) => `--- Session ${i + 1} ---\n${s}`).join("\n\n")}`
    : "";

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
          content: `You are a coaching intelligence assistant for an executive coach. Generate a concise session synopsis (150-200 words) from a coaching session transcript.

Focus on:
1. Key themes and topics discussed
2. Commitments and action items the client made
3. Emotional tone and energy level
4. Patterns or shifts from prior sessions (if context provided)
5. Recommended follow-up for the next session

Write in third person, present tense. Be specific about what was discussed, not generic. Use the client's first name. Do not include headers or bullet points — write as a flowing paragraph.`,
        },
        {
          role: "user",
          content: `Client: ${clientName}${contextBlock}\n\nCURRENT SESSION TRANSCRIPT:\n${transcript.slice(0, 15000)}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}
