# TODOS

## Analytics Roadmap

### Tier 2: Emotional Arc Mapping
**What:** Run GPT-4o-mini with structured JSON output on each synopsis to extract: `{ emotionalTone, confidence, volatility, valence }`. Plot per-client emotional trajectory (line graph of valence over sessions). Volatility indicator on client dossier (stable / shifting / volatile).
**Cost:** ~$0.01 per synopsis x 354 synopses = ~$3.50 one-time backfill.
**Depends on:** Nothing — synopses already exist.
**Added:** 2026-04-01

### Tier 2: Commitment Velocity
**What:** Compare action items from session N against synopsis text of sessions N+1, N+2 to detect resolution via GPT-4o-mini (classify: resolved / still open / dropped). Average sessions-to-resolution per client, trend line. Metric card per client + practice-wide average.
**Depends on:** Action items from Fathom (inconsistent — some sessions have them, some don't).
**Added:** 2026-04-01

### Tier 3: Coaching Intervention Fingerprinting
**What:** Classify Todd's utterances from rawSegments as: reframing / challenging / affirming / questioning / holding-space. Build intervention mix per client, correlate with outcomes. Batch classify, sample key moments rather than every turn.
**Why Tier 3:** High API cost, needs careful prompt engineering, uncertain ROI until Tier 1/2 prove value.
**Added:** 2026-04-01

### Tier 3: Cross-Client Theme Clustering
**What:** k-means or HDBSCAN on all 354 transcript embeddings to surface 5-8 macro themes. Dimensionality reduction (UMAP) for 2D visualization. Reveals practice specialization patterns.
**Why Tier 3:** Needs UMAP library, more complex visualization than current recharts setup.
**Added:** 2026-04-01

### Tier 3: Breakthrough Detection
**What:** Composite signal: embedding distance spike + positive emotional shift + commitment language increase. Auto-flag sessions as "breakthrough" moments. Map conditions that precede breakthroughs.
**Depends on:** Emotional arc (Tier 2) + topic drift (Tier 1) + commitment velocity (Tier 2).
**Added:** 2026-04-01

## Phase 2 Blockers

### Get Todd's invoice format
**What:** Ask Todd to forward his last 5 invoices before building the billing engine.
**Why:** The billing UI needs to match his existing client expectations. Does he send PDFs? Emails? Line items by date or session? Does he round to 15-min already? Does he bill non-session time?
**Depends on:** Nothing. Can do anytime before Phase 2.
**Added:** 2026-03-28 via /plan-eng-review

## Phase 3 Blockers

### Google Calendar setup
**What:** Ask Todd: does he have a dedicated coaching calendar, or are coaching sessions mixed into his main calendar?
**Why:** Pre-session briefs (Phase 3) need to know when sessions are scheduled. The Google Calendar API integration depends on knowing which calendar to sync.
**Depends on:** Nothing. Can do anytime before Phase 3.
**Added:** 2026-03-28 via /plan-eng-review

## Billing Follow-ups (post-overhaul)

### Shadow pgvector columns in schema.prisma to prevent accidental drop
**What:** `transcripts.embedding vector(1536)` and `transcripts.search_text` are managed via raw SQL outside Prisma (per the comment at `prisma/schema.prisma:166-167`). Prisma doesn't see them. Any future `prisma migrate dev` run will detect them as "drift" and try to DROP them — destroying 602+ rows of expensive pgvector embeddings + full-text search data.
**Why:** Discovered during the billing overhaul migration generation on 2026-04-16: `prisma migrate dev` warned "You are about to drop the column `embedding` on the `transcripts` table, which still contains 602 non-null values." This is a latent footgun on the project. The billing migration was hand-written to avoid the drop, but the next dev who runs `prisma migrate dev` could lose the data unless this is fixed.
**Fix:** Add to `Transcript` model in schema.prisma:
```prisma
embedding   Unsupported("vector(1536)")?
search_text String?
```
Then `prisma migrate dev` will see them and leave them alone. Plus a follow-up migration confirming Prisma sees the existing columns (no-op SQL).
**Depends on:** Nothing.
**Added:** 2026-04-16 via /plan-eng-review (billing overhaul) — surfaced as side discovery.

### Encrypt CoachSettings secret keys
**What:** `CoachSettings.stripeSecretKey`, `openaiApiKey`, `anthropicApiKey` are stored as plain strings in Postgres (`prisma/schema.prisma:240,247-248`). Move to Vercel env vars OR use Stripe Restricted Keys with read-only scope; for OpenAI/Anthropic, prefer env vars + KMS-style envelope encryption if DB storage is required.
**Why:** A DB leak (Neon mirror, backup file, accidental dump) grants full account access today. The billing system makes this a bigger target.
**Depends on:** Nothing. Standalone PR, ~1hr.
**Added:** 2026-04-16 via /plan-eng-review (billing overhaul)

### Screen-reader walkthrough of billing UI
**What:** Post-ship accessibility verification with VoiceOver (macOS) and NVDA (Windows) on the live billing surfaces — Billing tab, Clean-slate modal (focus trap + announcement), Draft invoice card with snapshot banner (`role="status"`), and the typed-confirmation flow.
**Why:** Plan specs all the ARIA + focus + contrast rules, but live verification catches edge cases the spec can't predict — focus order through the cadence reveal, screen-reader pronunciation of "$1,000.00" (does it say "one thousand dollars"?), modal entry timing relative to backdrop fade.
**Depends on:** Billing overhaul shipped to staging.
**Added:** 2026-04-16 via /plan-design-review (billing overhaul)

### Credit memo workflow (adjust-on-SENT invoice)
**What:** Build the parent/child invoice flow for refunds and credit notes against already-SENT invoices. Schema field `Invoice.parentInvoiceId` lands in the billing overhaul; the UI/route to issue a credit memo is deferred. Until built, Todd uses VOID + re-issue (loses audit link).
**Why:** Real coaching scenario — client disputes a session, Todd needs to refund partial amount without nuking the original invoice.
**Depends on:** Billing overhaul Phase 1 (parentInvoiceId field).
**Added:** 2026-04-16 via /plan-eng-review (billing overhaul)

## Phase 4 Bugs

### NLM retry_failed.py is broken
**What:** `coachiq/cron/retry_failed.py` has a TODO — it increments the retry counter but never actually re-fetches the transcript or re-attempts the NLM injection. Failed injections are silently dropped after 10 "retries."
**Why:** This means NLM injection failures are never recovered. In v3, the NLM worker moves to a Fly.io container and retries against PostgreSQL, so the fix looks different, but the bug should be addressed during the Phase 4 NLM worker rebuild.
**Depends on:** Phase 4 NLM worker migration.
**Added:** 2026-03-28 via /plan-eng-review
