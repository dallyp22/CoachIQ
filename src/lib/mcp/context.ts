import { AuthzError, resolveCoachByUserId, type ResolvedCoach } from "@/lib/authz";
import type { CoachRole } from "@/generated/prisma/enums";

/**
 * mcp-handler and the MCP SDK ship slightly different AuthInfo types, so we read
 * the one field we need — the verified token's `extra.userId` — defensively off
 * the request context rather than importing either package's shape.
 */
function extractUserId(extra: unknown): string | undefined {
  const authInfo = (extra as { authInfo?: { extra?: Record<string, unknown> } } | undefined)
    ?.authInfo;
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" ? userId : undefined;
}

/**
 * The bridge between an authenticated MCP request and CoachIQ's authorization
 * model. `withMcpAuth` + `verifyClerkToken` have already validated the OAuth
 * token and stashed the Clerk userId at `authInfo.extra.userId`; this resolves
 * that to the SAME ResolvedCoach the web app uses, so every tool inherits the
 * exact role scoping (OWNER = whole practice, COACH = own clients only).
 *
 * The `extra` argument is the RequestHandlerExtra the MCP SDK hands each tool
 * callback; its `authInfo` is populated by mcp-handler from the verified token.
 */
export async function resolveMcpCoach(
  extra: unknown,
  minRole: CoachRole = "COACH"
): Promise<ResolvedCoach> {
  return (await resolveMcpActor(extra, minRole)).coach;
}

/**
 * Like resolveMcpCoach but also returns the Clerk userId. Write tools need it as
 * the audit `actor` (billing_audit_logs.actor stores the Clerk user id, matching
 * how the web routes record who did what).
 */
export async function resolveMcpActor(
  extra: unknown,
  minRole: CoachRole = "COACH"
): Promise<{ coach: ResolvedCoach; userId: string }> {
  const userId = extractUserId(extra);
  if (!userId) {
    throw new AuthzError(401, "No authenticated user on this MCP request.", "unauthenticated");
  }
  const coach = await resolveCoachByUserId(userId, minRole);
  return { coach, userId };
}

/** A tool result carrying plain text. */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** A tool result carrying a JSON payload, pretty-printed for the model. */
export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * An error tool result. AuthzError messages are curated and safe to surface;
 * anything else (a Prisma exception, etc.) is logged server-side and returned to
 * the client as a generic message, so raw internal detail — SQL, constraint
 * names, schema — never leaks to the MCP caller.
 */
export function errorResult(err: unknown) {
  if (err instanceof AuthzError) {
    return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
  }
  console.error("[mcp] tool error:", err);
  return {
    content: [{ type: "text" as const, text: "Error: Something went wrong." }],
    isError: true,
  };
}
