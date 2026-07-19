# CoachIQ — Product Overview for Todd Zimbelman

## What It Is

CoachIQ is your personal coaching intelligence platform. It takes every coaching session you record with Fathom and turns it into searchable, actionable intelligence — session summaries, prep briefs, billing automation, and a searchable database of every conversation you've ever had with every client.

One login. One place for everything.

## How It Works

### The Automatic Pipeline

Every time you finish a coaching session on Zoom:

1. **Fathom records the session** and processes the transcript (this already happens)
2. **Fathom sends a webhook** to CoachIQ within 2-5 minutes of session end
3. **CoachIQ automatically:**
   - Identifies which client was in the meeting (by their email)
   - Calculates billable time (rounded up to nearest 15-min increment)
   - Stores the full transcript in your private database
   - Generates an AI synopsis of the session (key themes, commitments, follow-up)
   - Creates a time entry for billing
   - Writes a backup copy to your Google Drive (same as before)

You don't do anything. It just happens.

### What You See When You Log In

**Dashboard** — Your command center. Today's stats: active clients, sessions this week, hours billed, unbilled revenue. Recent session feed showing who you coached and when.

**Clients** — Every coaching client in one list. Click any name to open their dossier.

**Client Dossier** — The heart of CoachIQ. For each client you see:
- Profile info (rate, cadence, status) — editable inline
- **Prep Brief** — AI-generated briefing you can pull up before any session. Covers: last session recap, open commitments, patterns to watch, suggested focus areas. One click to generate.
- **Session Timeline** — Every session with date, duration, AI synopsis, and link to the Fathom recording
- **Open Notebook** — One click to jump into that client's NotebookLM notebook for conversational deep-dive queries
- **Drive Folder** — Direct link to their transcript archive
- **Billing Summary** — Total sessions, hours, and rate

**Search** — Type a natural language question like "which clients discussed succession planning" or "find sessions about burnout." CoachIQ searches across ALL your transcripts using AI-powered semantic search. Results show matching excerpts with context, the client name, session date, and a link to the recording.

**Invoices** — See all unbilled sessions across all clients. One click generates draft invoices grouped by client. Review line items (date, session, hours, rate, amount), edit if needed, then approve. When Stripe is connected, one more click sends the invoice to the client with a payment link.

**Analytics** — Practice-level view. Sessions over time, top clients by volume, total billed, unbilled, and collection stats. See how your practice is trending.

**Settings** — Your profile, billing defaults, and API keys. When I hand this over, you'll input your own OpenAI key here and everything keeps running.

### The Prep Brief (Todd's "Walk In Prepared" Feature)

Before any coaching session, go to that client's dossier and click "Generate Brief." In about 5 seconds, CoachIQ reads your last 5 sessions with that client and produces:

- **Last Session Recap** — What you covered, what they committed to
- **Open Commitments** — Action items they said they'd do (flags overdue ones)
- **Patterns to Watch** — Recurring themes across sessions (e.g., "delegation anxiety keeps surfacing")
- **Suggested Focus Areas** — Specific questions or topics to explore

You walk in knowing exactly where you left off with every client, even if you haven't seen them in a month.

### The Search (Todd's "Find Anything" Feature)

You have 90+ clients and hundreds of sessions. Without CoachIQ, finding something means opening individual NotebookLM notebooks one by one.

With CoachIQ, you type "which clients have talked about leaving their role" and get instant results across ALL clients, ALL sessions, with the exact transcript excerpts highlighted. Cross-client patterns that were invisible before are now one search away.

---

## Data Security

### Where Your Data Lives

| Data | Location | Who Can Access |
|------|----------|---------------|
| Client profiles, sessions, transcripts, invoices | **Neon PostgreSQL** (cloud database) | Only CoachIQ via encrypted connection |
| Transcript backups | **Google Drive** (your account) | You (Todd's Google account) |
| NotebookLM notebooks | **Google NotebookLM** (your account) | You (Todd's Google account) |
| Fathom recordings | **Fathom** (your account) | You (Todd's Fathom account) |
| App hosting | **Vercel** (serverless) | No persistent storage on Vercel |

### Security Measures

**Authentication:** Google SSO via Clerk. Only authorized Google accounts can log in. No passwords to manage. Session tokens expire automatically.

**Database encryption:** All connections to Neon PostgreSQL use TLS/SSL encryption in transit. Neon encrypts data at rest. The database is not publicly accessible — only CoachIQ's server-side code can connect.

**API keys:** Your OpenAI and Anthropic keys are stored in the database (not in code). They never appear in the browser or client-side code. When displayed in Settings, they're masked (showing only the last 4 characters).

**Webhook security:** The Fathom webhook uses HMAC-SHA256 signature verification. Every incoming webhook is cryptographically verified before processing. Replay attacks are blocked (timestamps older than 5 minutes are rejected). Stripe webhooks use the same signature verification pattern.

**No data sharing:** CoachIQ does not share your data with anyone. AI features send transcript excerpts to OpenAI for processing (synopses, search, embeddings), but OpenAI's API terms state they do not train on API inputs. When you switch to your own API keys, the data flows through your own OpenAI account.

**Access control:** All dashboard routes require authentication. The only public endpoints are the webhooks (Fathom, Stripe), which verify cryptographic signatures before processing any data, and the scheduled cron endpoints, which require a secret token and shut themselves off entirely if that token is ever missing in production.

**Sensitive data handling:**
- `.env` file with secrets is gitignored (never committed to source control)
- Client email addresses and session content are stored only in the encrypted database
- No coaching data is logged to application logs
- Backup transcripts go to YOUR Google Drive, not a shared account

### What Goes to OpenAI

When you use these features, CoachIQ sends data to OpenAI's API:

| Feature | What's Sent | Why |
|---------|------------|-----|
| Synopsis generation | Transcript text (truncated to ~5000 words) | To generate the session summary |
| Prep brief | Last 5 session synopses | To generate the pre-session briefing |
| Semantic search | Your search query (one sentence) | To convert your question into a search vector |
| Embeddings | Transcript text (truncated) | To enable semantic search (one-time per transcript) |

OpenAI does not store or train on data sent via their API. When you input your own OpenAI key in Settings, all API calls go through your account.

---

## Monthly Cost

| Service | Cost | What It Does |
|---------|------|-------------|
| Vercel (hosting) | $20/mo | Runs the web app |
| Neon (database) | $0 (free tier) | Stores all your data |
| OpenAI (AI features) | ~$5-15/mo | Synopses, search, embeddings |
| Clerk (auth) | $0 (free tier) | Google sign-in |
| Stripe (billing) | 2.9% + 30¢ per payment | Only on collected payments |
| **Total** | **~$25-35/mo** | |

---

## What You Need to Do

1. **Log in** at https://coachiq-delta.vercel.app with your Google account
2. **Update the Fathom webhook** in your Fathom settings to: `https://coachiq-delta.vercel.app/api/webhook/fathom` — this makes new sessions flow into CoachIQ automatically
3. **Add your OpenAI API key** in Settings (get one at https://platform.openai.com/api-keys) — this powers the AI features under your own account
4. **Set up Stripe** when you're ready to send invoices (add your Stripe key in Settings)

That's it. Everything else is automatic.

