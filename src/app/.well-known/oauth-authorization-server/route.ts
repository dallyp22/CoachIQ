import {
  authServerMetadataHandlerClerk,
  metadataCorsOptionsRequestHandler,
} from "@clerk/mcp-tools/next";

/**
 * OAuth Authorization Server Metadata (RFC 8414), proxied from Clerk. Some MCP
 * clients still fetch this in addition to the protected-resource metadata.
 * Must be publicly reachable (see middleware).
 */
const handler = authServerMetadataHandlerClerk();
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
