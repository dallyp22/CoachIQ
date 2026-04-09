# CoachIQ: AI-Powered Coaching Intelligence Platform

**Technical White Paper v3.0**
April 8, 2026 | Co-Create Coaching

---

## 1. Executive Summary

CoachIQ is a purpose-built intelligence platform that transforms executive coaching from a memory-dependent craft into a data-driven practice. It automates the entire post-session workflow — from recording capture to billing — while layering AI-powered insights on top of every coaching conversation.

Built for Todd Zimbelman's executive coaching practice at Co-Create Coaching, CoachIQ replaces a patchwork of spreadsheets, manual note-taking, and calendar-checking with a single system that compounds intelligence with every session. The platform processes coaching sessions automatically within seconds of completion, generates pre-session prep briefs, synchronizes with Google Calendar for schedule intelligence, analyzes coaching patterns across the entire client portfolio, and provides semantic search across hundreds of historical conversations.

The core architectural insight: coaching conversations are an undervalued data asset. A single session is a note. A hundred sessions across dozens of clients is a dataset — one that reveals patterns about what works, who's progressing, and where the coach's own methodology creates breakthroughs.

**Platform at a Glance:**

| Metric | Value |
|--------|-------|
| Active coaching clients | 92 |
| Historical sessions captured | 578+ |
| AI-generated synopses | 354+ |
| NotebookLM notebooks linked | 86 |
| Processing time per session | < 60 seconds |
| Monthly operational cost | ~$25–35 |
| Total codebase | ~25,800 lines TypeScript |
| API endpoints | 22+ |
| Scheduled automations | 3 cron jobs |

---

## 2. The Problem

Executive coaches at scale face a compounding information management crisis. A coach managing 40–90+ active clients on weekly or biweekly cadences generates thousands of hours of session data annually. Without a system:

- **Pre-session preparation** relies on memory or scattered notes, degrading session quality as the client roster grows
- **Billing** is manual, error-prone, and often delayed — directly impacting revenue
- **Institutional knowledge** lives in the coach's head, not in a queryable system
- **Calendar awareness** is disconnected from client context — the coach sees "10 AM — Executive Coaching" but has no instant recall of what happened last session
- **Non-recorded sessions** (clients who decline recording) create tracking blind spots
- **Practice-level patterns** are invisible — the coach can't see which techniques produce breakthroughs, which clients are disengaging, or how talk ratios vary across relationships

The cost of these gaps isn't just operational inefficiency — it's degraded coaching quality. When a coach can't instantly recall a client's open commitments, recurring patterns, or the exact words they used three sessions ago, the coaching relationship suffers. And when the coach can't see across their entire portfolio, practice improvement becomes guesswork.

**The scale of the problem:**

| Manual Task | Time Per Client/Month | At 90 Clients |
|------------|----------------------|---------------|
| Pre-session review | 5–10 min | 7.5–15 hours |
| Session note-taking | 5 min | 7.5 hours |
| Invoice preparation | 10–15 min | 15–22.5 hours |
| Calendar cross-referencing | 3 min | 4.5 hours |
| **Total admin overhead** | | **34.5–49.5 hours/month** |

CoachIQ eliminates nearly all of it.

---

## 3. Architecture

### 3.1 System Overview

CoachIQ is a modern web application built on the Next.js 16 App Router framework, deployed as serverless functions on Vercel with a managed PostgreSQL database on Neon. The architecture prioritizes zero-maintenance operation: once configured, the system runs entirely on webhooks, cron jobs, and event-driven processing.

```
                         ┌─────────────┐
                         │   Fathom    │
                         │  (Zoom AI)  │
                         └──────┬──────┘
                                │ webhook (HMAC-SHA256)
                         ┌──────▼──────┐
                         │   CoachIQ   │
                         │  (Vercel)   │
                         ├─────────────┤
                         │  Next.js 16 │       ┌──────────┐
                         │  App Router │◄─────►│  Stripe  │
                         └──┬───┬───┬──┘       │ Payments │
                            │   │   │          └──────────┘
                   ┌────────┘   │   └────────┐
                   ▼            ▼            ▼
             ┌──────────┐ ┌──────────┐ ┌──────────┐
             │   Neon   │ │  OpenAI  │ │  Google  │
             │ Postgres │ │   API    │ │  Suite   │
             │ pgvector │ │ GPT-4o   │ │ Cal/Drive│
             └──────────┘ └──────────┘ └──────────┘
```

### 3.2 Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | Next.js 16.2.1 (App Router) | Full-stack React with server components |
| Language | TypeScript 5 (strict) | Type safety across frontend and backend |
| Database | Neon PostgreSQL + pgvector | Managed Postgres with vector similarity search |
| ORM | Prisma 7.6.0 | Type-safe database access with migrations |
| Auth | Clerk 7.0.7 | Google SSO, session management |
| AI — Intelligence | OpenAI GPT-4o-mini | Session synopses, prep briefs, daily briefings, coaching analytics |
| AI — Embeddings | text-embedding-3-small (1536d) | Semantic search across transcripts |
| Calendar | Google Calendar API v3 | Schedule sync, session tracking, prep automation |
| Payments | Stripe 21.0.1 | Invoice generation, payment collection, webhooks |
| Storage | Google Drive API v3 | Durable transcript archival (zero data loss) |
| Knowledge | Google NotebookLM | Per-client conversational AI notebooks |
| Hosting | Vercel | Serverless deployment with cron support |
| Visualization | Recharts 3.8.1 + custom SVG | Analytics charts and word cloud rendering |
| Design | Tailwind CSS 4 | Custom design system with warm dark sidebar |

### 3.3 Data Model

CoachIQ's schema consists of 9 interconnected models in PostgreSQL:

**Client** — The central entity. 92 clients with email matching (primary + secondary), configurable hourly rates, billing/meeting cadence, and links to external systems (Stripe customer, NotebookLM notebook, Google Drive folder). An `allowsFathom` flag distinguishes clients who permit recording from those tracked via calendar only.

**Session** — Each coaching interaction. Tracks duration, billable minutes (15-minute increments), Fathom recording links, AI-generated synopsis, and a `sessionSource` enum (FATHOM, CALENDAR, MANUAL) for provenance.

**Transcript** — Full session text with speaker segmentation, word count, and a 1536-dimensional OpenAI embedding for semantic search. Dual-indexed: IVFFlat for approximate nearest neighbor vector search and GIN for full-text search via tsvector.

**TimeEntry** — Auto-generated billing records tied to sessions. Status progression: UNBILLED → STAGED → INVOICED → PAID (or WRITTEN_OFF).

**Invoice** — Draft-to-paid lifecycle with Stripe integration. Line items stored as JSON for flexible formatting.

**PrepBrief** — AI-generated pre-session briefings with target session date, content, and delivery tracking.

**CoachSettings** — Singleton configuration: coach profile, API keys, calendar ID, billing defaults.

**Job** — Async task queue for background processing: embedding generation, synopsis creation, calendar sync, NotebookLM injection.

### 3.4 The v3 Architecture Shift

CoachIQ's architecture has evolved through three major iterations, each expanding what's possible:

| Version | Intelligence Layer | Limitation |
|---------|-------------------|------------|
| v0.1 | Google NotebookLM only | Cookie-dependent, per-client silos, no cross-client search |
| v2.0 | NotebookLM + PostgreSQL (read-only) | NotebookLM still critical path for prep/search |
| **v3.0** | **PostgreSQL + pgvector + GPT-4o-mini** | **Self-contained — NotebookLM is optional enrichment** |

The v3 architecture stores full transcripts in PostgreSQL with pgvector embeddings. Core features — synopses, prep briefs, search, analytics, billing — work independently of any external dependency. NotebookLM remains available for conversational deep-dives but is no longer on the critical path. When NotebookLM cookies expire (every 2–4 weeks), the system continues operating without interruption.

---

## 4. Core Capabilities

### 4.1 Automatic Session Capture

When a coaching session ends on Zoom, Fathom processes the recording and fires a webhook to CoachIQ within 2–5 minutes. The pipeline:

1. **Signature verification** — HMAC-SHA256 with timestamp tolerance (300s) prevents replay attacks
2. **Idempotency** — Unique constraint on `fathomRecordingId` prevents duplicate processing
3. **Title filtering** — Regex filter (configurable) ensures only coaching sessions are captured
4. **Client identification** — External attendee email matched against client records (primary + secondary emails)
5. **Duration calculation** — Recording timestamps determine actual duration; billable minutes rounded to 15-minute increments
6. **Google Drive backup** — Formatted transcript written to client's Drive folder *synchronously* before any other processing (zero data loss guarantee)
7. **Atomic data creation** — Session, Transcript, and TimeEntry created in a single database transaction
8. **Background job queuing** — Embedding generation, synopsis creation, and NotebookLM injection queued for async processing

The entire pipeline executes in under 60 seconds with zero manual intervention. Todd finishes a call, and by the time he's refilling his coffee, the session is captured, summarized, billed, and searchable.

### 4.2 AI-Powered Intelligence

**Session Synopses** — Each transcript is processed through GPT-4o-mini to produce a structured 150–200 word synopsis covering key themes, client commitments, emotional tone, and coaching observations. Synopses are written in third person, present tense, with specific details rather than generic summaries. Prior synopses are provided as context for longitudinal consistency — the AI knows what came before.

**Pre-Session Prep Briefs** — Before each coaching session, CoachIQ generates a structured briefing from the client's last 5 sessions:

- **Last Session Recap** — 2–3 sentence summary of the previous conversation
- **Open Commitments** — Action items the client committed to, with overdue flags
- **Patterns to Watch** — Recurring themes across recent sessions (e.g., "delegation anxiety keeps surfacing")
- **Suggested Focus Areas** — Specific topics and questions for the upcoming session

Prep briefs are generated automatically via cron (5-minute intervals within a configurable delivery window) or on-demand from the client dossier. Generation time: ~5 seconds.

**Daily Briefings** — A "Generate Day Brief" button on the dashboard produces an AI overview of the entire coaching day: full schedule with client context, per-client talking points, expected billable hours, and back-to-back session warnings.

### 4.3 Coaching Analytics (NEW in v3)

CoachIQ extracts quantitative coaching metrics from session transcripts, surfacing patterns that are invisible in individual conversations but obvious in aggregate.

**Talk Ratios** — Measures the balance between coach and client speaking time across every session. Healthy coaching sessions typically feature 70–80% client talk time. CoachIQ calculates per-client averages and surfaces outliers — clients who may need more space, or sessions where the coach dominated.

**Question Density** — Counts the ratio of questions to statements in the coach's utterances. A higher question ratio generally indicates a more coaching-oriented (vs. consulting-oriented) approach. Tracked per-client and across the practice.

**Ownership Language** — Detects "I" statements, commitment language, and action-oriented phrasing in client speech. High ownership language correlates with client agency and engagement. Low ownership may signal passivity or dependence on the coaching relationship.

**Topic Drift** — Measures how far each session's content strays from the client's established themes (via embedding distance from the client's centroid). High drift isn't inherently good or bad — but persistent drift may indicate a client in transition, while zero drift may indicate stagnation.

**Practice-Wide Benchmarks** — All metrics are aggregated across the full client portfolio, enabling the coach to see practice-level patterns: average talk ratios, question density distribution, ownership trends. A privacy toggle anonymizes all client names for use in presentations, peer coaching, or supervision.

**Word Cloud Analytics** — A custom SVG word cloud visualization extracts the most frequent themes from session synopses or full transcripts:
- Filter by client, date range, or entire practice
- Toggle between synopsis (cleaner themes) and transcript (deeper patterns) sources
- Dynamic stop word filtering: strips all client/coach names, contractions, filler words, URLs, timestamps, and conversational noise
- Bigram extraction for multi-word phrases (e.g., "emotional regulation", "leadership development")
- Archimedean spiral layout with frequency-weighted sizing and color

### 4.4 Semantic Search

CoachIQ implements a hybrid search architecture that enables natural language queries across the entire coaching corpus:

1. **Semantic search** (primary) — The query is embedded via OpenAI's text-embedding-3-small model and matched against transcript embeddings using pgvector cosine similarity. This finds conceptually related content even when exact keywords don't match. "Clients struggling with work-life balance" finds sessions discussing "boundary setting" and "evening email habits."

2. **Full-text search** (fallback) — PostgreSQL tsvector/tsquery with English dictionary stemming, ranked by ts_rank. Returns highlighted excerpts with matched terms.

3. **Client name search** — ILIKE matching against client names and companies. Searching "Rita" returns all of Rita's sessions, ranked by recency.

Results are deduplicated and ranked: client name matches first, then content matches by relevance score. Response time: under 1 second across 500+ sessions.

### 4.5 Google Calendar Integration

CoachIQ reads the coach's Google Calendar as a one-way data source (calendar → CoachIQ, never the reverse), enabling:

**Coaching Schedule Widget** — The dashboard displays an interactive calendar with three views:
- **Day view** — Expandable session cards with full synopsis, action items, and prep brief content. Per-meeting "Generate Brief" button.
- **Week view** — 7-column grid (Mon–Sun) with compact session cards. Click any session to drill into day view.
- **Month view** — Traditional calendar grid with session pills showing client name, time, and brief-ready indicators.

**Calendar-Based Session Tracking** — For clients who don't permit Fathom recording, CoachIQ creates sessions and time entries from calendar events. The `allowsFathom` toggle on each client controls this behavior. Calendar-sourced sessions are tagged with `sessionSource: CALENDAR` and display a badge in the UI.

**Fathom-Calendar Cross-Linking** — The calendar sync links past calendar events to existing Fathom sessions by matching the client attendee email within a 2-hour time window, creating a unified timeline.

**Scheduled Automation:**
- Calendar sync cron: every 15 minutes
- Prep brief delivery cron: every 5 minutes (within configurable window)
- Start-of-day brief cron: 7 AM CT weekdays

### 4.6 Billing Automation

The billing pipeline eliminates manual time tracking and invoice preparation:

1. **Auto-capture** — Every session creates a TimeEntry with billable hours calculated from recording duration (rounded up to 15-minute increments) at the client's hourly rate ($300 default, configurable per client)
2. **Invoice staging** — "Generate Invoices" collects all UNBILLED entries, groups by client, and creates DRAFT invoices with auto-generated invoice numbers (CIQ-YYYY-NNNN)
3. **Review & approval** — Todd reviews draft invoices, adjusts line items if needed, approves
4. **Stripe delivery** — Approved invoices sent via Stripe API with payment links
5. **Payment tracking** — Stripe webhooks update invoice and time entry status through SENT → PAID
6. **Status visibility** — Dashboard shows unbilled revenue total, unbilled client count, monthly hours, and revenue trends

For a practice with 90+ clients, this eliminates an estimated 15–22 hours of monthly invoicing work.

### 4.7 NotebookLM Integration

Each client has a dedicated Google NotebookLM notebook (86 total). Transcripts are synced via a Chrome extension that:
- Queries CoachIQ for pending (unsynced) sessions
- Injects transcript text into the client's NotebookLM notebook
- Reports sync results back to CoachIQ

This creates a conversational AI layer on top of the transcript archive. Todd can ask NotebookLM natural language questions about any client's coaching history — "How has Sarah's thinking about her VP role evolved since January?" — and get answers grounded in actual session content.

**Historical backfill:** 578 sessions across all clients have been successfully injected into NotebookLM notebooks.

### 4.8 Google Drive Integration

Transcripts are archived to Google Drive as the durable source of truth:
- Folder hierarchy: `CoachIQ/[ClientName]/[ClientName]_[Date]_[RecordingID].txt`
- Formatted transcripts include: client name, date, summary, action items, full speaker-attributed transcript
- Synchronous, blocking write before any other processing — zero data loss guarantee
- OAuth 2.0 refresh token auto-renewal

---

## 5. Design Philosophy

CoachIQ's interface follows a "luxury briefing document" aesthetic — deliberately not a generic SaaS dashboard. The design system was crafted to feel like a tool built for one person, not a platform marketed to thousands.

### 5.1 Visual Identity

**Typography** — Three typefaces, each with a specific role:
- **Instrument Serif** — Display headers and client names. Editorial weight that signals authority and curation, not a spreadsheet.
- **DM Sans** — Body text and UI labels. Clean geometric sans with strong tabular number support.
- **Geist Mono** — Data tables, dates, durations, dollar amounts. Precision feel for quantitative information.

**Color** — Restrained palette with one meaningful accent:
- **Background:** #FAFAF9 (warm off-white, not sterile white)
- **Sidebar:** #1C1917 (warm near-black, not cold gray)
- **Accent:** #B45309 (amber-gold, used only for active states and CTAs — not decorative)
- **Semantic colors** for status: success green, warning yellow, error red

**Layout** — Split-pane dossier architecture:
- Persistent dark left sidebar (280px) with compact client list and search
- Scrollable right content pane with 1200px max width
- 4-column stat grid on dashboard, responsive to 2-column on mobile

### 5.2 Design Risks (Deliberate Departures)

1. **Warm dark sidebar + light content** — Most competitors use all-light layouts. CoachIQ's dark sidebar creates visual separation and a "workspace" feel.
2. **Amber accent instead of blue/purple/teal** — An unexpected choice that reads as warmth, expertise, and gold-standard quality rather than generic tech.
3. **Serif display font for client names** — Editorial authority. Every client's name rendered in Instrument Serif signals that this person matters — they're not a row in a CRM.

The three-second reaction the design aims for: "This is mine."

### 5.3 Dark Mode & Responsiveness

Full dark theme support with adjusted accent tones. Mobile responsive layout with collapsible sidebar, touch-friendly tap targets, and a bottom tab bar for primary navigation on small screens.

---

## 6. Security & Privacy

**Authentication** — Google SSO via Clerk. No passwords stored. Single-user access control (Todd only).

**Webhook Security** — Fathom and Stripe webhooks verified via HMAC-SHA256 cryptographic signatures with timestamp replay protection (300-second tolerance).

**Data Protection:**
- All database connections encrypted via TLS/SSL (Neon managed)
- API keys stored in database with masked display in UI (last 4 characters only)
- Service account credentials stored as environment variables, never in code
- `.env` and `service-account.json` excluded from version control
- Cron endpoints authenticated via `CRON_SECRET` bearer token

**SQL Injection Prevention** — All database queries use parameterized statements via Prisma's query builders with positional parameters ($1, $2, etc.).

**AI Data Handling** — Transcripts are sent to OpenAI's API for synopsis generation and embedding creation. Per OpenAI's API data usage policy, API inputs are not used for model training. No coaching data is shared with third parties.

**Privacy Controls** — Analytics page includes a privacy toggle that anonymizes all client names to "Client 1", "Client 2", etc. — enabling the coach to discuss practice patterns in supervision, peer groups, or presentations without exposing client identity.

---

## 7. The Compounding Intelligence Model

CoachIQ's value isn't static — it compounds with every session recorded. This is the central insight of the platform: coaching data becomes exponentially more valuable as it accumulates.

### 7.1 The Intelligence Curve

| Sessions per Client | Intelligence Available |
|--------------------|----------------------|
| 1 | "What did we discuss?" — Basic session summary |
| 3–5 | "What topics keep coming up?" — Pattern recognition, prep briefs begin |
| 5–10 | "How has their thinking evolved?" — Longitudinal trends, emotional arcs |
| 10–20 | "What interventions correlate with progress?" — Methodology insights |
| 20+ | "Generate a comprehensive engagement summary" — Full coaching intelligence archive |

### 7.2 Cross-Client Intelligence

With 90+ clients and 500+ sessions, CoachIQ enables a category of insight that no other coaching tool provides: **cross-client pattern recognition.**

- Which themes appear across multiple clients? (e.g., "delegation anxiety" surfaces in 40% of C-suite clients)
- How do talk ratios differ between high-progress and plateauing clients?
- What does the coach's question density look like in breakthrough sessions vs. routine check-ins?
- Are there clients whose engagement patterns match historical churn signals?

This transforms coaching from an intuitive art practiced in isolation to an evidence-informed profession with a feedback loop.

---

## 8. Competitive Landscape

### 8.1 Why Not Existing Tools?

| Platform | Approach | CoachIQ Advantage |
|----------|----------|-------------------|
| **Coaching.com** | Generic CRM with scheduling | No AI intelligence, no transcript analysis, no semantic search |
| **Profi** | Marketplace + practice management | Client-facing, not coach-intelligence-focused. No session NLP. |
| **CoachAccountable** | Forms, worksheets, goal tracking | Manual data entry model. No automatic session capture. |
| **Delenta** | All-in-one coaching platform | Broad but shallow. No per-session AI analysis or cross-client analytics. |
| **Notion/Obsidian** | General-purpose knowledge management | No coaching-specific intelligence. Manual curation required. |
| **Fathom alone** | Session recording + summary | Per-meeting view only. No cross-session, cross-client intelligence. No billing. |

### 8.2 CoachIQ's Moat

1. **Zero-manual data entry** — Session capture, transcript storage, billing — all automatic from webhook to invoice
2. **Cross-client semantic search** — Natural language queries across 500+ sessions, all clients. No other coaching platform offers this.
3. **Quantitative coaching analytics** — Talk ratios, question density, ownership language, topic drift. Coaching measured, not just managed.
4. **Integrated billing pipeline** — CRM and invoicing in one system, auto-calculated from session data
5. **Self-contained intelligence** — No dependency on external services for core features. PostgreSQL + pgvector + GPT-4o-mini = complete platform.
6. **Premium design** — Not a generic SaaS template. A tool that feels like it was built for one person, because it was.

---

## 9. Operational Profile

### 9.1 Cost Structure

| Service | Monthly Cost | Notes |
|---------|-------------|-------|
| Vercel (Pro) | ~$20 | Web hosting, serverless functions, cron |
| Neon PostgreSQL | $0 | Free tier (generous limits) |
| OpenAI API | ~$5–15 | Synopses, embeddings, analytics, search |
| Google Calendar/Drive API | $0 | Within workspace quotas |
| Clerk | $0 | Free tier |
| Fathom | Existing subscription | Todd already uses this |
| Stripe | 2.9% + $0.30/payment | Only on collected payments |
| **Total** | **~$25–35/month** | Plus Stripe transaction fees |

At ~$30/month for a system that eliminates 30–50 hours of monthly admin work, the ROI is roughly **1,000:1** at Todd's billing rate.

### 9.2 Reliability

- **Vercel:** 99.99% SLA, automatic scaling, zero server maintenance
- **Fathom webhook delivery:** Automatic retries on failure
- **Google Drive writes:** Synchronous and blocking — zero data loss by design
- **NotebookLM injection:** Asynchronous, best-effort — graceful degradation when cookies expire
- **Database:** Neon managed PostgreSQL with automated backups

### 9.3 Maintenance

Zero-touch operation. Sessions capture, process, and bill automatically. Manual actions limited to:
- Invoice review and approval (~10 minutes/month)
- Occasional prep brief generation before sessions
- NotebookLM cookie refresh (~5 minutes every 2–4 weeks)

---

## 10. Roadmap

### Completed (as of April 8, 2026)

- Full Next.js web application with client dossiers, session timelines, search, analytics
- Fathom webhook pipeline with atomic session capture
- AI synopses (GPT-4o-mini) with longitudinal context
- Pre-session prep briefs (manual + automated via cron)
- Google Calendar integration with day/week/month schedule views
- Calendar-based session tracking for non-Fathom clients
- Fathom-calendar cross-linking
- Semantic + full-text + client name hybrid search
- Coaching analytics: talk ratios, question density, ownership language, topic drift
- Word cloud analytics with bigram extraction and privacy mode
- Practice-wide benchmarks with anonymization toggle
- Stripe invoice pipeline (draft → approved → sent → paid)
- NotebookLM sync via Chrome extension (578 sessions backfilled)
- Google Drive transcript archival (zero data loss)
- Dark mode + mobile responsive layout
- Background job queue for async processing
- Settings page with API key management

### Planned — Tier 2 (Near-term)

- **Emotional Arc Mapping** — Extract emotional tone, confidence, volatility, and valence from each synopsis via structured GPT-4o-mini output. Plot per-client emotional trajectories over time. Stability indicators on client dossier pages.
- **Commitment Velocity** — Track action item resolution rates by comparing commitments in session N against synopses of sessions N+1, N+2. Average sessions-to-resolution per client. Practice-wide completion trends.

### Planned — Tier 3 (Advanced Intelligence)

- **Coaching Intervention Fingerprinting** — Classify the coach's utterances (reframing, challenging, affirming, questioning, holding-space) and correlate intervention types with client outcomes.
- **Cross-Client Theme Clustering** — k-means/HDBSCAN on transcript embeddings with UMAP dimensionality reduction. Surface 5–8 macro themes across the entire practice and visualize in 2D.
- **Breakthrough Detection** — Composite signal combining embedding distance spikes, emotional shifts, and commitment language increases. Auto-flag transformative sessions and map the conditions that precede breakthroughs.

### Planned — Phase 3 (Automation & Delivery)

- Goal tracking with multi-session commitment persistence and follow-up reminders
- Email delivery for prep briefs and daily briefings
- Automated calendar-triggered prep brief delivery (30 minutes before session)
- Branded PDF progress reports for client-facing delivery

### Long-term Vision (2027+)

- **Multi-coach support** — Role-based access, per-coach analytics, practice-level aggregation
- **SaaS productization** — Self-service onboarding, multi-provider transcript support (Otter.ai, Fireflies, Rev), subscription pricing
- **Audio overviews** — Podcast-style session recaps for on-the-go consumption
- **Vertical integration** within the VS Insights platform ecosystem

---

## 11. Why This Matters

Coaching is one of the last professional disciplines to benefit from AI-powered operational intelligence. Lawyers have case management with NLP. Doctors have clinical decision support. Financial advisors have portfolio analytics. Executive coaches have... a Zoom recording and a good memory.

CoachIQ changes that equation.

The platform doesn't replace the coach's intuition, empathy, or relationship skills — those remain irreplaceable. What it replaces is the administrative overhead that prevents a great coach from being a great coach at scale. When Todd walks into his seventh session of the day, he has the same preparation quality for client #7 as he did for client #1 at 8 AM. When a client references something from six months ago, the system has it. When it's time to invoice, the numbers are already calculated.

And as the analytics layer matures — emotional arcs, breakthrough detection, intervention fingerprinting — CoachIQ will begin answering a question most coaches never get to ask: "What, specifically, am I doing that works?"

That's not a CRM. That's a coaching intelligence system.

---

## 12. Conclusion

CoachIQ transforms the raw data exhaust of coaching sessions — recordings, transcripts, calendar events — into structured intelligence that compounds over time. Every session makes the system smarter: synopses build context for prep briefs, transcripts enrich semantic search, coaching analytics surface patterns across the practice, and the compounding data asset creates an ever-deepening understanding of what works.

For a practice operating at Todd's scale — 92 active clients, 578+ sessions captured, hundreds of hours billed annually — the difference between "I think we discussed goal-setting last time" and "Your last session focused on your team's response to the Q2 reorganization — you committed to having one-on-ones with each direct report by March 15th, and your ownership language has increased 23% over the last quarter" is the difference between good coaching and exceptional coaching.

CoachIQ makes the exceptional version automatic.

---

*Built by Dallas Polivka for Co-Create Coaching.*
*Powered by Next.js, PostgreSQL + pgvector, OpenAI, Google Cloud Platform, and Stripe.*
*Single-tenant deployment. ~$30/month operational cost. ~25,800 lines of TypeScript.*
