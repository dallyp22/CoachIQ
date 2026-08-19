import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandlerClerk,
} from "@clerk/mcp-tools/next";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the CoachIQ MCP server.
 * MCP clients fetch this to discover that Clerk is our authorization server.
 * Advertised to clients via the resourceMetadataPath in the MCP route's
 * withMcpAuth config. Must be publicly reachable (see middleware).
 */
const handler = protectedResourceHandlerClerk({
  scopes_supported: ["openid", "profile", "email"],
});
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
