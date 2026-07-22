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

## Cron / Compute Follow-ups (post twice-daily consolidation)

### Build the daily-brief pre-warm properly (start-of-day cron now UNSCHEDULED)
**Priority:** P1
**What:** Confirmed broken: `start-of-day` fetched Clerk-protected `/api/daily-brief`, got redirected to sign-in, and 500'd on every run — and nothing persisted the result anyway (the "cached and ready" comment described machinery that never existed). As of v0.1.1.0 the cron is removed from `vercel.json` (route file kept, documented as unscheduled). The dashboard still generates the brief on open, same as before.
**Fix path:** Add a `DailyBrief` table keyed by date; either accept CRON_SECRET auth on the daily-brief route (add it to `src/middleware.ts` public routes) or extract brief generation into a lib and call it inline from a re-scheduled cron; have the dashboard read today's row and only regenerate on explicit refresh. Re-add the cron to vercel.json once this works.
**Why:** Wasted LLM spend on every dashboard open; the pre-generation feature Todd was promised has never fired.
**Added:** 2026-07-06 via /ship; updated 2026-07-15 (cron unscheduled).

### Paginate calendar sync — the 96h window can silently drop billable sessions
**Priority:** P1
**What:** `syncCalendarSessions` (`src/lib/calendar-sync.ts`) fetches a single page (`maxResults: 250`) with no `nextPageToken` loop. This branch widened its window to 96h (72h lookback + 24h ahead). A busy/shared calendar over a long weekend can exceed one page; overflow events are silently dropped — the Sessions and **UNBILLED TimeEntries never get created**, i.e. silent revenue under-capture with nothing in `result.errors`. (Brief delivery got a truncation guard this round; calendar-sync did not.)
**Fix path:** Paginate via `nextPageToken` (reuse `fetchEvents` in the same file), or at minimum push a truncation error into `result.errors` when `nextPageToken` is set.
**Added:** 2026-07-15 via /ship (adversarial + red-team review).

### Validate coachingTitleFilter regex at save time
**Priority:** P1
**What:** `filterCoachingEvents` builds `new RegExp(coachingTitleFilter, "i")` from the DB-stored, user-editable setting. An invalid pattern throws synchronously inside BOTH workday-sync steps, failing the whole consolidated cron (500) for a full day until the next run. Under the old 15-min crons the blast radius of a bad setting was one tick; now it's a workday.
**Fix path:** Validate/compile the pattern when it's saved in the Settings API, and wrap the runtime `RegExp` construction in try/catch that falls back to the default filter while surfacing a per-run warning.
**Added:** 2026-07-15 via /ship (red-team review).

### Batch the per-event N+1 dedup queries
**Priority:** P2
**What:** Two hot-path N+1s now amplified by the wider window: `calendar-sync.ts` awaits `session.findUnique({ where: { calendarEventId } })` per event, and `deliver-briefs.ts` awaits `prepBrief.findFirst` per event. Each is a sequential Neon round-trip that extends the cron's awake time (working against the whole point of this consolidation). `calendar-sync` also re-fetches a just-created row with `findUnique` inside the transaction instead of using `create`'s return value.
**Fix path:** Batch-load existing `calendarEventId`s / briefs for the window into a Set/Map before the loop; use `tx.session.create`'s return value.
**Added:** 2026-07-15 via /ship (performance review).

### Time budget should be a deadline from request start, not a per-lib clock
**Priority:** P2
**What:** `deliver-briefs.ts` starts its 240s `TIME_BUDGET_MS` at its own entry, but calendar sync runs first (unbudgeted) under the shared `maxDuration = 300`. On a slow Monday backlog, sync + 240s of briefs can exceed 300s and Vercel kills the function mid-LLM-call — losing the JSON response and the "deferred to next run" error, the exact silent failure the budget was meant to prevent.
**Fix path:** Compute a deadline (`requestStart + maxDuration*1000 - safetyMargin`) in the route and pass it into `deliverDueBriefs`; size the margin to one worst-case LLM call (~60-90s) so no brief starts unless it can finish.
**Added:** 2026-07-15 via /ship (performance + adversarial review).

### invoice-generation at 12:05 can race the 12:00 backlog sync
**Priority:** P2
**What:** `vercel.json` fires invoice-generation at 12:05; on a heavy Monday, workday-sync (12:00) may still be mid-sync. `generateForAllDueClients` snapshots UNBILLED time entries at run time, so weekend entries created after the snapshot miss this cycle and drift to the next invoice — silently light invoices on the morning with the most new entries.
**Fix path:** Move invoice generation later (e.g. 12:15+), or run it as a step inside workday-sync after sync completes.
**Added:** 2026-07-15 via /ship (adversarial review).

### No alerting channel exists — cron partials and dropped recordings are log-only
**Priority:** P1 (raised from P2 on 2026-07-19)
**What:** Two silent-failure surfaces share one root cause: the app has no alerting mechanism at all. No mailer is installed, and the `COACHIQ_ALERT_EMAIL_*` / `COACHIQ_SMTP_*` vars in `.env.example` are v1 Python-worker leftovers that nothing in the TypeScript app reads — so "wire the existing SMTP alert vars" (the original fix path here) is not actually available.
1. **Cron:** workday-sync returns 500 only when BOTH steps throw. A revoked LLM key makes every brief fail every run while sync succeeds → 200 `"partial"` indefinitely, so status-code monitoring never fires.
2. **Fathom webhook (new in multi-coach):** a coach whose stored webhook secret is stale or undecryptable has every recording rejected with a 401, and Fathom stops retrying — the recordings are permanently lost. `src/lib/webhook-coach.ts` emits a named, actionable `console.error` ("coach X's signature did not verify — re-register") rather than a bare 401, which is a real improvement, but nothing pages anyone.
**Fix path:** Pick one channel and wire both surfaces to it — a Slack incoming webhook is the least infrastructure, Resend if email is wanted. Or configure Vercel log drains/alerts on the `[fathom-webhook]` prefix. Both call sites already emit structured, greppable messages, so the remaining work is the channel itself.
**Added:** 2026-07-15 via /ship (adversarial review); expanded 2026-07-19 during Phase 3 when the webhook gained the same failure shape and the SMTP vars turned out to be dead.

### Persist a sync high-water-mark so missed runs can't permanently lose billable sessions
**Priority:** P1
**What:** Vercel crons never retry. If consecutive workday-sync failures (broken env var, paused project, long-weekend outage) bridge an event's exit from the rolling 72h lookback, its Session and UNBILLED TimeEntry are never created — silent, permanent, billable loss with no record it was missed. There is no reconciliation or "last successful sync at T" marker letting the next healthy run stretch its lookback to cover the actual gap.
**Fix path:** Persist a last-successful-sync timestamp (CoachSettings or a small SyncState row); each run uses `max(72h, now - lastSuccess + slack)` as lookback and updates the marker only on success.
**Added:** 2026-07-19 via /ship (adversarial review).

### 72h sync lookback resurrects deleted sessions and can double-bill
**Priority:** P2
**What:** Calendar-sync dedup is solely "does a Session with this calendarEventId exist." If Todd deletes a mis-matched or non-billable synced session, the next run recreates it — fresh UNBILLED TimeEntry + sessionCount increment — as long as the event is inside the rolling 72h window. If the original entry was already invoiced, the client can be billed twice. Existed at 24h; the 72h window triples the exposure and guarantees Monday resurrection of Friday cleanup.
**Fix path:** Tombstone dismissed calendarEventIds (small table or a soft-delete flag on Session) and have sync skip tombstoned IDs.
**Added:** 2026-07-19 via /ship (adversarial review).

### Unify the workday-sync step gates (calendar off ≠ healthy quiet day)
**Priority:** P2
**What:** `syncCalendarSessions` gates on `settings.calendarSyncEnabled` but never checks `hasCalendarCredentials`; `deliverDueBriefs` checks `googleCalendarId` + credentials but ignores `calendarSyncEnabled`. Toggling calendar sync OFF in Settings still burns LLM spend on briefs twice a day, and a disabled/unconfigured sync returns an empty `SyncResult` that workday-sync reports as a clean "completed" run — misconfiguration is indistinguishable from a quiet day. Adversarial review sharpened the second half: the missing `{status:"skipped", reason}` in `SyncResult` is a response-contract defect on its own — silently stopped session creation means silently stopped billing.
**Fix path:** Gate both steps on the same predicate (calendarSyncEnabled AND calendar configured) and have `syncCalendarSessions` return an explicit `{status:"skipped", reason}` like `deliverDueBriefs` does.
**Added:** 2026-07-19 via /ship (red-team + adversarial review).

### Add a timeout to the prep-brief LLM fetch
**Priority:** P2
**What:** `generatePrepBrief`'s fetch to the chat provider (`src/lib/prep-brief.ts`) passes no AbortSignal, so one hung connection sails past deliver-briefs' 240s budget (which only checks between events) to the 300s maxDuration kill — losing the whole JSON response including the errors array.
**Fix path:** `AbortSignal.timeout(60_000)` on the provider fetch so a hung call becomes a caught per-brief error instead of a function kill.
**Added:** 2026-07-19 via /ship (red-team review).

### Share the settings/clients load between workday-sync steps
**Priority:** P2
**What:** Each workday-sync step independently re-queries `coachSettings.findFirst` and a near-identical non-CHURNED `client.findMany` from Neon (calendar-sync.ts:28/50 and deliver-briefs.ts). Two redundant round-trips per tick in the cron whose whole purpose is minimizing Neon compute. Fold into the "Batch the per-event N+1 dedup queries" work.
**Fix path:** Optional settings/clients params on both libs (or a shared loader), fetched once in the route; share the email→client Map construction.
**Added:** 2026-07-19 via /ship (performance review).

### Extract a shared cron test-env helper + dedicated cron-auth tests
**Priority:** P3
**What:** CRON_SECRET/VERCEL env save-restore, `makeRequest`, and the fail-closed 503 test are duplicated across all three cron route test files in two divergent patterns; `verifyCronSecret` has no dedicated `tests/lib/cron-auth.test.ts` and is re-verified through each route.
**Fix path:** `tests/helpers/cron-env.ts` (makeCronRequest + withCronEnv snapshot/restore), a direct cron-auth test for the 401/503/local-dev matrix, one thin wiring assertion per route file.
**Added:** 2026-07-19 via /ship (maintainability review).

### briefDeliveryMinutes is now a dead knob below 6.5h
**What:** `deliverDueBriefs` uses `max(briefDeliveryMinutes, 390)` so any realistic setting (5–120 min) has no effect, but the Settings UI still presents it as "minutes before session." Also, 0 does not disable auto-delivery (it falls back to 30 via `|| 30`).
**Fix path:** Either remove/relabel the setting (delivery timing is schedule-driven now) or honor 0/null as "auto-delivery off" with an early return.
**Added:** 2026-07-06 via /ship (adversarial review, finding 4)

### PrepBrief dedup: match on calendar event ID + unique constraint
**What:** Dedup is a ±1h check-then-act on `(clientId, targetSessionDate)` with no unique constraint — concurrent manual-button + cron runs can double-generate, and back-to-back sessions under 1h apart for the same client suppress the second brief. 2026-07-19 adversarial review added: a session rescheduled by under 1h after its brief generated gets no fresh brief and the old brief keeps the wrong `targetSessionDate`; and `generatePrepBrief` stamps every cron brief `delivered: true` even for later-cancelled or already-started sessions, so the delivered flag is unreliable.
**Fix path:** Store the calendar event ID on PrepBrief, dedup on it, and add a unique constraint (mirrors the Session.calendarEventId pattern); regenerate on event-time change; set delivered only when the brief is actually surfaced.
**Added:** 2026-07-06 via /ship (adversarial review, finding 10); expanded 2026-07-19.

## Tooling

### `npm run lint` is unusable — 2,682 errors, almost all from .venv
**Priority:** P3
**What:** ESLint walks `.venv/lib` (the Python virtualenv from the v1 worker) and third-party JS in `chrome-extension/`, producing 11,345 problems of which ~2,682 are errors. Real errors in authored `src/` code are buried; verified 2026-07-19 that the current branch has zero lint errors in changed files, but only by filtering the output by hand.
**Why:** A lint command nobody can read is a lint command nobody runs, so it catches nothing. It also can't be wired into CI in this state.
**Fix path:** Add `.venv/`, `chrome-extension/`, and `src/generated/` to the ESLint ignore config (flat config `ignores` in `eslint.config.mjs`), then fix whatever genuine errors remain in `src/` and `scripts/`.
**Added:** 2026-07-19 during /ship.

## Design System Follow-ups

### Chart colors don't follow the theme
**Priority:** P3
**What:** `src/components/client-insights.tsx` passes literal hexes (`#16A34A`, `#2563EB`) to Recharts for line/area/sparkline colors. Recharts takes color values, not CSS classes, so these can't use the semantic tokens the rest of the app now uses — they stay light-mode green and blue on the dark surface.
**Why:** Dark mode is reachable and automatic (`theme-toggle.tsx` honors `prefers-color-scheme` on first load), so anyone with a dark OS sees charts that don't match the surrounding UI.
**Fix path:** Read the resolved token values at runtime (`getComputedStyle(document.documentElement).getPropertyValue('--success')`) and pass those to Recharts, re-reading on theme change; or define a small chart palette with explicit light/dark pairs.
**Added:** 2026-07-19 via /plan-design-review follow-up sweep.

## Multi-Coach Follow-ups (foundation SHIPPED v0.2.0.0 2026-07-19)

### My Settings self-serve tier + coach edit/deactivate UI
**Priority:** P2
**What:** The deferred half of Pipeline PRD §12.5 (D2 scope trim, 2026-07-19): per-coach self-serve settings (own calendar ID, coaching filter, profile) and proper edit/deactivate UI on the Coaches list. v1 ships Add Coach + Coaches list + role gates only; owner edits coach rows on behalf of coaches.
**Why:** Fine at 2 coaches; at 3+ the owner becomes a helpdesk for every calendar tweak, and INACTIVE needs a real button.
**Depends on:** Multi-coach foundation shipped.
**Added:** 2026-07-19 via /plan-eng-review.

### Drop deprecated CoachSettings identity columns
**Priority:** P3
**What:** After the Settings rewire (old Coach Profile/Integrations sections repointed at the OWNER's Coach row), `coachName`, `coachEmail`, `googleCalendarId`, `coachingTitleFilter`, `fathomWebhookSecret` on CoachSettings are dead columns with `/// @deprecated` comments. Drop them in a follow-up migration after ~2 weeks of soak post-Kurt-onboarding.
**Why:** Dead columns invite the written-but-never-read divergence bug class back (this repo's signature failure: DB fathomWebhookSecret/stripeSecretKey were UI-edited but env always won).
**Caution:** Destructive migration — hand-write it with the same pgvector-column care as the foundation migration.
**Depends on:** Foundation shipped + soak.
**Added:** 2026-07-19 via /plan-eng-review.

### NotebookLM multi-coach story
**Priority:** P3
**What:** NLM notebooks are per-client under Todd's single NotebookLM account (`COACHIQ_NOTEBOOKLM_STORAGE_PATH`, global `nlmLastSynced`). Kurt's clients get transcripts in his Drive root but no NotebookLM notebooks — deliberately. Decide per-coach NLM (Kurt's own account + per-coach storage path) as part of the Phase 4 NLM worker rebuild; design the rebuilt worker per-coach from the start.
**Why:** "Where's Kurt's NotebookLM?" will come up at the onboarding meeting — the answer is "deliberately later, with the worker rebuild."
**Depends on:** Phase 4 NLM worker migration (existing TODO below).
**Added:** 2026-07-19 via /plan-eng-review.

## Pipeline Follow-ups (from the 2026-07-20 pre-merge review, v0.3.0.0)

Ten reviewers ran on the Pipeline diff. The correctness and security findings were fixed before merge; these are what was deliberately deferred.

### The stalest-first index doesn't match the sort
**Priority:** P1
`prospects_nextActivityAt_idx` is a default btree (ASC NULLS LAST) but every list query orders `ASC NULLS FIRST`, so Postgres cannot use it to satisfy the ordering and sorts the filtered set on every request. Both list surfaces are force-dynamic, so this is paid Neon compute on every page view. Fix: `CREATE INDEX ... ("nextActivityAt" ASC NULLS FIRST, "createdAt" DESC)` plus coach-scoped composites. Verify with EXPLAIN that the Sort node disappears.

### PATCH /api/pipeline/stages is the weakest-tested route in the module
**Priority:** P1
13 of 17 branches untested, including every validation branch and the validate-before-write atomicity the code is built around ("applying half a reorder leaves the board scrambled"). It is ADMIN-reachable and practice-wide: one bad write reshapes every coach's board and every report. Also `canArchiveStage` has zero tests and no UI caller — the one rule `stages.ts` exists to enforce.

### Reports load every open prospect into memory
**Priority:** P2
`reports/summary` and the reports page both fetch all open prospects with no limit, then ship every id back as an `IN (...)` list. Fine at Todd's scale, linear in pipeline size. Push the aggregation into SQL with `groupBy` and use a relation filter instead of the id list.

### Batch prospect create opens one transaction per row
**Priority:** P2
A 40-row tracker paste costs 40 sequential BEGIN/COMMIT round trips. The per-row transaction is what buys the 207 partial-success response, so batching means either savepoints or pre-validating in JS and batching the survivors.

### Stage settings PATCH issues one findUnique per patch
**Priority:** P2
A drag-reorder sends all seven stages, so one reorder is seven sequential round trips before any write. Hoist to a single `findMany({ where: { id: { in: ids } } })` and validate against a Set — same fail-before-write behavior, one round trip.

### Duplicated query logic across the API routes and the pages
**Priority:** P2
The pages query Prisma directly and the API routes duplicate the same where-clause chains and helpers; nothing calls `GET /api/pipeline/prospects` or `/reports/summary` at all. `OPPORTUNITY_TYPES` is redeclared in four files while Prisma already generates the enum. `MS_PER_DAY` is defined four times with three different rounding semantics, so "days in stage" can differ between the row and the API. Extract shared helpers, or delete the unconsumed routes.

### Migration hygiene
**Priority:** P2
The stage seed is not idempotent (no ON CONFLICT, no unique on name) — safe only because `CREATE TYPE` fails first on a full re-run, but re-running section 5 alone would silently duplicate stages. No `down.sql` is committed. The directory is `20260719_pipeline_module` with no HHMMSS, so correct ordering against `20260719_multi_coach_foundation` depends on 'm' sorting before 'p'. `prospect_stage_changes` has no FK on `fromStageId`/`toStageId`.

### Dossier accessibility
**Priority:** P2
Three bare `<label>` elements with no `htmlFor` (stage select, activity date, owner). The shared `Field` component in `components/modal.tsx` has the same defect, which this diff multiplied across every new form. Async status messages need `role="status"`. Fix `Field` once and most of it resolves.

### The stage select commits on change
**Priority:** P2
On Windows/Linux Chrome and Firefox, arrow-keying a closed `<select>` fires change immediately — so a keyboard user tabbing to Stage and pressing Down moves the prospect, writes a history row, and can trip the lost-reason modal or the convert offer without ever opening the menu. Stage the selection and commit behind an explicit control, or commit on blur.

### Delete on a timeline row is invisible on touch
**Priority:** P2
`opacity-0` until group-hover. Touch devices have no hover, so the control is invisible but still hit-testable — an unconfirmed, irreversible delete under the thumb at the right edge of every row. Show it at reduced contrast instead, and add a confirm step.

### Mobile bottom nav is at seven tabs
**Priority:** P3
Adding Pipeline took it from 6 to 7 flex-1 tabs — 53.6px each at 375px. Tap targets still clear 44px, but the labels have ~5px of breathing room and an eighth tab is not possible. Consider moving Settings behind the top header or grouping Groups/Invoices under "More".

### Batch create returns raw Prisma error text
**Priority:** P3
The per-row failure path returns `err.message` verbatim, and Prisma messages carry table, column and constraint names. Log the detail server-side, return a fixed string.

### Convert returns 201 for a link
**Priority:** P3
The linked branch creates no client — it modifies two existing rows — so 200 is the honest code. Also the module mixes 422 (convert's missing email) and 400 (everywhere else) for validation failures; pick one.

### No E2E coverage for any UI flow
**Priority:** P3
The repo has no E2E framework and zero `.tsx` has ever been tested. The pure logic that shipped in React files (`parsePasted` is now covered; `move()` in stage settings, the timeline merge, and the `cells.tsx` branches are not) could be unit-tested today without a DOM. The user flows — paste import, mark lost, reorder stages, empty states — need a real browser.

## Phase 4 Bugs

### NLM retry_failed.py is broken
**What:** `coachiq/cron/retry_failed.py` has a TODO — it increments the retry counter but never actually re-fetches the transcript or re-attempts the NLM injection. Failed injections are silently dropped after 10 "retries."
**Why:** This means NLM injection failures are never recovered. In v3, the NLM worker moves to a Fly.io container and retries against PostgreSQL, so the fix looks different, but the bug should be addressed during the Phase 4 NLM worker rebuild.
**Depends on:** Phase 4 NLM worker migration.
**Added:** 2026-03-28 via /plan-eng-review

## Secrets Follow-ups (from the 2026-07-20 encryption ship, v0.3.1.0)

### Key-rotation / rekey path for encrypted secrets
**Priority:** P2
**What:** There is no way to rotate `COACHIQ_SECRETS_KEY`. The `"v1:"` prefix is a format version, not a key id, and `encryptSecret` always uses the current key. If the key is ever rotated or lost, every existing envelope (CoachSettings AND the per-coach `Coach.fathomApiKey`/`fathomWebhookSecret` from v0.2.0.0) becomes undecryptable, and the failure is silent + asymmetric: `getOpenAIKey`/`getAnthropicKey` throw (AI features down), `webhook-coach.ts` `secretOf` returns null → Fathom recordings dropped with no retry, while the Settings page still renders healthy `•••` masks because `maskCoachSecret` swallows the decrypt error.
**Why:** Turns a routine key rotation or a lost env var into silent, partly-unrecoverable outage. Pre-existing (the v0.2.0.0 columns already had this), surfaced by the v0.3.1.0 adversarial review.
**Fix path:** A `scripts/rekey-secrets.ts` (decrypt-under-old-key → re-encrypt-under-new, both keys passed in), and/or a key-id in the envelope (`v1:<kid>:…`) so mixed-key states are expressible. Consider surfacing a decrypt-error state in the Settings response instead of a normal mask so the "looks healthy while broken" gap closes.
**Added:** 2026-07-20 via /ship adversarial review (encryption ship).

### Settings secret inputs: mask-append silently drops a key rotation
**Priority:** P3
**What:** `settings-form.tsx` binds the GET mask (`•••1234`) as the input `value`. If an admin edits by appending to the shown mask instead of clearing it, the submitted value still starts with `•••`, so `isMasked()` skips it and the new key is silently discarded — a rotation appears to succeed while the old key stays active. Also: a secret can't be cleared back to `null` through PATCH (empty string is falsy, so it's skipped).
**Why:** Silent no-op on a security-relevant action (key rotation). Pre-existing (carried from the old `startsWith("•••")` check), flagged by the v0.3.1.0 security + adversarial reviews.
**Fix path:** Render secret inputs empty with the mask shown as placeholder/adornment only, so any typed value is a real new key; and/or add an explicit "clear" affordance that sends a sentinel the route maps to null.
**Added:** 2026-07-20 via /ship review army (encryption ship).

## Multi-Coach Cron Follow-ups (from the 2026-07-22 Phase 5 ship)

### Namespace calendarEventId per calendar (global-unique underbilling)
**Priority:** P2
**What:** `Session.calendarEventId` is globally unique, but Google event IDs are unique only per calendar and are shared across attendees' copies of an invitation. When two coaches' calendars carry the same event ID (a genuinely shared meeting with clients of both coaches), the first-synced coach owns the only Session/TimeEntry and the later coach is silently `skipped` — nondeterministic underbilling, not a crash.
**Why:** Rare for 1-coach-1-client coaching sessions (the only events that create billable time, and they're title-filtered), but real and worsens as coach count grows. Flagged by the Phase 5 adversarial review.
**Fix path:** Add `coachId` (or `calendarId`) to `Session`, make the uniqueness + the sync's `findUnique` dedup composite `(coachId, calendarEventId)`. Schema migration — rehearse on a Neon branch per Handoff §4.
**Added:** 2026-07-22 via /ship adversarial review (Phase 5).

### Hard-enforce the cron deadline (cancellation) + fair per-coach budgeting
**Priority:** P2
**What:** `workday-sync` now shares one 270s deadline across calendar-sync + brief delivery, checked cooperatively between coaches/events. Two gaps: (1) an in-flight Calendar or LLM `fetch` isn't cancellation-bounded, so a single slow call can cross the 300s function cap; (2) coaches are processed oldest-first, so if the first coach exhausts the budget, later coaches are always starved and — since brief recovery only looks back 60min while runs are 6h apart — their sessions age out to manual-only.
**Why:** Neither bites a 2-coach practice (calendar-sync is seconds; a run rarely has enough sessions to exhaust 270s), but both are systematic at scale. Flagged by the Phase 5 adversarial review.
**Fix path:** Bound external calls with `AbortController` tied to the deadline; give each coach a fair slice of the remaining budget (or a durable continuation cursor) instead of first-come-all.
**Added:** 2026-07-22 via /ship adversarial review (Phase 5).

### Reject cross-client email-alias collisions per coach
**Priority:** P3
**What:** Client uniqueness is only `(coachId, primary email)`. Secondary emails aren't checked against other clients' addresses, and calendar-sync / brief matching build a last-write-wins email→client map. Two clients under one coach sharing an alias can mint a Session/TimeEntry or brief against the wrong client. Pre-existing (not introduced by Phase 5); within one coach's tenant, never cross-coach.
**Why:** Billing misattribution within a coach's book. Flagged by the Phase 5 adversarial review as pre-existing.
**Fix path:** Enforce alias uniqueness per coach on client create/update, or fail closed when building the match map instead of overwriting.
**Added:** 2026-07-22 via /ship adversarial review (Phase 5).

### Per-coach calendar/settings editing UI
**Priority:** P2
**What:** The legacy practice Settings form still edits calendar config (googleCalendarId, coachingTitleFilter) that Phase 5 reads from the Coach row; the PATCH mirrors those onto the *founding* coach as a bridge. A non-founding coach (e.g. Kurt) has no UI to edit their own calendar after Add Coach, and the owner editing Settings only affects the founder's row.
**Why:** The mirror is a bridge, not the real model — per-coach config should be edited per-coach. Ties into the already-filed "coach edit/deactivate UI" P2.
**Fix path:** Add per-coach calendar/title-filter editing in the Coaches section; once it exists, drop the calendar fields from the practice Settings form and the founder-mirror.
**Added:** 2026-07-22 via /ship adversarial review (Phase 5).

## Completed

### Encrypt CoachSettings secret keys
**Completed:** v0.3.1.0 (2026-07-20)
The four secret columns (`openaiApiKey`, `anthropicApiKey`, `stripeSecretKey`, `fathomWebhookSecret`) now go through the AES-256-GCM envelope (`src/lib/secrets.ts`) via a new `src/lib/coach-secrets.ts` helper: encrypt-on-write in `settings/route.ts`, decrypt-tolerant read in `ai.ts`, decrypt-then-mask on every secret column in the GET/PATCH responses (which also closed a raw `fathomWebhookSecret` leak in the response spread). One-shot backfill (`scripts/backfill-coach-settings-secrets.ts`) with authenticate-first + per-column compare-and-swap. Openai/anthropic are the live consumers; stripe/fathom columns are protected-at-rest but dormant. Remaining secrets work filed under "Secrets Follow-ups" above. **Backfill must be rehearsed on a Neon branch and run against prod per Handoff §4 — not yet run.**

### Sales Pipeline module
**Completed:** v0.3.0.0 (2026-07-20)
Prospects, activities, stages, reports, convert-to-client. Full data model, 7 API routes, and UI. Migrated to production (86 clients / 714 sessions / 711 embeddings unchanged). 14 follow-up items filed under "Pipeline Follow-ups" above.

### No way to create a client in the product — blocks Kurt onboarding
**Completed:** v0.2.0.0 (2026-07-19)
Was a P0. `POST /api/clients` + Add Client form + bulk paste shipped, scoped to the resolved coach, pre-filling `hourlyRate` from the coach's `defaultHourlyRate`. This was the gating item for onboarding any second coach.

### Multi-coach foundation
**Completed:** v0.2.0.0 (2026-07-19)
Coach model + OWNER/ADMIN/COACH roles, `requireCoach()` authz + full read-site scoping, coach-aware Fathom ingress with per-coach HMAC, AES-256-GCM secrets helper (`src/lib/secrets.ts`), Coaches settings section + Add Coach flow with Clerk invites. Phases 0–4 of PRD §12. **Phases 5 (cron coach-iteration) and 6 (Kurt dry-run) are NOT done** — see "Multi-Coach Follow-ups" and the note in the Handoff section below.

### Shadow pgvector columns in schema.prisma to prevent accidental drop
**Completed:** v0.2.0.0 (2026-07-19)
`transcripts.embedding` and `transcripts.search_text` are now declared `Unsupported(...)` in `prisma/schema.prisma:359-360`, so `prisma migrate dev` sees them and won't propose dropping 711 rows of paid embeddings. The pipeline migration's schema comment documents the same hazard for the new partial unique index.

### Wire up Vitest integration tests against a test Neon branch
**Completed:** v0.3.0.0 (2026-07-20)
`npm run test:runtime` runs the `tests/api/pipeline/*.runtime.test.ts` suites (64 tests) against a real Neon branch with `PIPELINE_RUNTIME_TESTS=1` + `DATABASE_URL`. Pattern (`--no-file-parallelism`, scope counts to suite-created rows because the branch is a prod clone) documented in `tests/api/pipeline/README.md`. **Note:** the original ask was about the *billing* DB paths (`generateInvoiceForClient`, `/api/admin/billing/reset`, `allocateInvoiceNumber`) — those specific surfaces still lack integration tests, so a narrower "billing integration tests" item may be worth re-filing if that coverage matters.

### Twice-daily cron consolidation
**Completed:** v0.1.1.0 (2026-07-19)
Shared cron auth + extracted brief-delivery lib; calendar-sync and deliver-briefs folded into workday-sync. Follow-ups filed under "Cron / Compute Follow-ups" above.
