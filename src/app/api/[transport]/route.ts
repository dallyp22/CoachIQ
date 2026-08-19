import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth } from "@clerk/nextjs/server";
import { registerCoachIqTools } from "@/lib/mcp/tools";

/**
 * CoachIQ MCP server (Streamable HTTP at /api/mcp, SSE at /api/sse).
 *
 * Auth: every request carries a Clerk OAuth machine token. `withMcpAuth` +
 * `verifyClerkToken` validate it and expose the Clerk userId at
 * `authInfo.extra.userId`; each tool resolves that to the same ResolvedCoach the
 * web app uses (see src/lib/mcp/context.ts). The tools themselves live in
 * src/lib/mcp/tools.ts.
 *
 * The `[transport]` dynamic segment coexists with the static /api/* routes —
 * Next.js prefers the specific static route, so this only ever catches /api/mcp
 * and /api/sse.
 */

export const maxDuration = 60;

const handler = createMcpHandler((server) => {
  registerCoachIqTools(server);
});

const authHandler = withMcpAuth(
  handler,
  async (_req, token) => {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    return verifyClerkToken(clerkAuth, token);
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  }
);

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
