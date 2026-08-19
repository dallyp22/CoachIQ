# Connecting CoachIQ to Claude (MCP)

CoachIQ exposes a **remote MCP server** so you can ask it questions and take
actions directly from Claude (claude.ai in the browser, or the Claude desktop
app). You sign in with the **same account you use on the CoachIQ website**, and
Claude only ever sees what your role is allowed to see — Todd sees the whole
practice, a coach sees only their own clients.

## What you can do from Claude

**Ask about your practice (read):**
- Search your session transcripts by meaning — "what did I discuss with Acme
  about succession planning?"
- List your clients; pull one session's synopsis, action items, and transcript.
- (Coming online in phases) daily brief, analytics, pipeline, invoices, feedback.

**Take safe actions (write):** *(phased in — see CHANGELOG)*
- Add a client, log a prospect activity, move a prospect's pipeline stage, submit
  feedback. **Billing actions stay on the website** — nothing in Claude can send
  or approve an invoice.

## One-time setup

**The MCP URL is:** `https://<your-coachiq-domain>/api/mcp`
*(Dallas will give you the exact domain.)*

### claude.ai (browser)
1. Go to **Settings → Connectors** (or **Add connectors** from the chat).
2. Click **Add custom connector**.
3. Paste the MCP URL above and save.
4. Click **Connect**. A CoachIQ / Clerk sign-in window opens.
5. Sign in with your CoachIQ account (the same Google/email you use on the site)
   and approve access.
6. Done. CoachIQ's tools now appear in your chats.

### Claude Desktop
1. **Settings → Connectors → Add custom connector**.
2. Paste the MCP URL, save, and click **Connect**.
3. Sign in with your CoachIQ account and approve.

If your Claude client doesn't support remote connectors directly, you can bridge
it locally with:
```
npx mcp-remote https://<your-coachiq-domain>/api/mcp
```
This opens the same browser sign-in the first time.

## How it stays secure

- Auth is **Clerk OAuth** — Claude never holds your password; it gets a scoped
  token you can revoke anytime in your Clerk account.
- Every tool call resolves you to your CoachIQ coach record and applies the
  **exact same role scoping as the website** (`OWNER` / `ADMIN` / `COACH`).
- You must have signed into the CoachIQ website at least once before connecting
  (that's what links your login to your coach profile).

## Troubleshooting

- **"This account is not registered as a coach"** — sign into the CoachIQ
  website once first, then reconnect.
- **Sign-in window doesn't appear** — make sure pop-ups are allowed, or use the
  `npx mcp-remote` bridge above.
- **Tools missing after connecting** — disconnect and reconnect the connector;
  Claude re-reads the tool list on connect.

## For Dallas (operator notes)

- Server code: `src/app/api/[transport]/route.ts` (Streamable HTTP at `/api/mcp`).
- OAuth discovery: `src/app/.well-known/oauth-protected-resource/mcp/route.ts`
  and `src/app/.well-known/oauth-authorization-server/route.ts`.
- Tools: `src/lib/mcp/tools.ts`; auth bridge: `src/lib/mcp/context.ts` →
  `resolveCoachByUserId` in `src/lib/authz.ts`.
- **Clerk dashboard prerequisite:** enable **OAuth Applications / Dynamic Client
  Registration** for the instance, or connectors can't complete the flow.
- `NEXT_PUBLIC_APP_URL` must be the canonical public URL; OAuth resource metadata
  is derived from the request origin.
- Verify locally with `npx @modelcontextprotocol/inspector` against
  `http://localhost:3000/api/mcp`.
