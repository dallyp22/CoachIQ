import { prisma } from "@/lib/db";
import { readCoachSecret } from "@/lib/coach-secrets";

/**
 * Get the active OpenAI API key.
 * Checks CoachSettings first (Todd's key), falls back to env var.
 *
 * The stored key is decrypted through readCoachSecret, which tolerates a
 * legacy plaintext row that predates encryption.
 */
export async function getOpenAIKey(): Promise<string> {
  const settings = await prisma.coachSettings.findFirst();
  const key =
    readCoachSecret(settings?.openaiApiKey) ||
    process.env.OPEN_AI_API ||
    process.env.OPENAI_API_KEY;
  if (!key) throw new Error("No OpenAI API key configured");
  return key;
}

/**
 * Get the active Anthropic API key.
 */
export async function getAnthropicKey(): Promise<string> {
  const settings = await prisma.coachSettings.findFirst();
  const key = readCoachSecret(settings?.anthropicApiKey) || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No Anthropic API key configured");
  return key;
}

export interface ChatProvider {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Pick the chat-completion provider. OpenRouter is preferred when
 * OPENROUTER_API_KEY is set — gives us model flexibility (Claude, GPT,
 * Gemini) behind one OpenAI-compatible API. Falls back to OpenAI directly.
 *
 * Override the model with the BRIEF_MODEL env var. Sensible defaults:
 *   - OpenRouter present  → anthropic/claude-sonnet-4.6
 *   - OpenAI fallback     → gpt-4o-mini
 */
export async function getChatProvider(): Promise<ChatProvider> {
  // Accept both naming conventions: OPENROUTER_API_KEY (OpenRouter docs)
  // and OPEN_ROUTER_API_KEY (matches the OPEN_AI_API pattern already used here).
  const orKey =
    process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;
  if (orKey) {
    return {
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: orKey,
      defaultModel:
        process.env.BRIEF_MODEL || "anthropic/claude-sonnet-4.6",
      extraHeaders: {
        "HTTP-Referer":
          process.env.OPENROUTER_REFERER || "https://coachiq.vercel.app",
        "X-Title": "CoachIQ",
      },
    };
  }
  return {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: await getOpenAIKey(),
    defaultModel: process.env.BRIEF_MODEL || "gpt-4o-mini",
  };
}

/**
 * Generate a coaching session synopsis. Routes through whatever chat
 * provider is configured (OpenRouter > OpenAI). Pure text output, no
 * json_schema — any modern chat model works.
 */
export async function generateSynopsis(
  transcript: string,
  clientName: string,
  priorSynopses: string[] = []
): Promise<string> {
  const provider = await getChatProvider();

  const contextBlock =
    priorSynopses.length > 0
      ? `\n\nPRIOR SESSION SYNOPSES (most recent first):\n${priorSynopses
          .map((s, i) => `--- Session ${i + 1} ---\n${s}`)
          .join("\n\n")}`
      : "";

  const resp = await fetch(provider.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      ...(provider.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: provider.defaultModel,
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
    throw new Error(`Chat API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}
