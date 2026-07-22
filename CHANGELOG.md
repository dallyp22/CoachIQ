# Changelog

All notable changes to CoachIQ are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versions as MAJOR.MINOR.PATCH.MICRO.

## [0.3.2.0] - 2026-07-22

Multi-coach calendar automation. The nightly crons — calendar sync, prep briefs, and the daily briefing — read a single practice-wide calendar, so a second coach's sessions were silently invisible to all of them. They now run per coach: each coach's own calendar is matched against only that coach's clients, so onboarding a second coach gives them working calendar sync, prep briefs, and a daily brief — not just Fathom recordings.

### Changed
- **Calendar sync runs per coach.** Each coach's calendar events are matched against that coach's own clients (never the whole practice), so a coach's meeting can't mint a session or billable time on another coach's client. Non-Fathom clients get sessions and unbilled time entries from calendar events, exactly as before — now for every coach, not just the owner.
- **Prep briefs and the daily brief are per coach.** Briefs are generated for each coach's upcoming sessions from their own calendar, and are now addressed to whoever coaches that client by name, instead of hardcoding one coach.
- **The workday cron shares one time budget** across calendar sync and brief delivery (rather than granting each the full window), and processes coaches in a stable order.
- **Editing the practice calendar in Settings now reaches the crons.** The owner's calendar id and title filter, edited in the existing Settings form, are mirrored onto the owner's coach record — the source the crons now read — in one transaction.

### Notes
- No schema change: every per-coach field already existed from the multi-coach foundation (v0.2.0.0).
- Known follow-ups filed in TODOS.md: per-calendar `calendarEventId` namespacing for shared meetings, hard deadline cancellation + fair per-coach budgeting at scale, and a per-coach calendar-editing UI.

## [0.3.1.0] - 2026-07-20

Practice-level secrets are encrypted at rest. The API keys stored in Settings sat in the database as plaintext, so any copy of it — a Neon branch, a backup, an accidental dump — handed over live Stripe, OpenAI, and Anthropic credentials. They now go through the same AES-256-GCM envelope the per-coach Fathom secrets already used, and the Settings page's claim that they're "encrypted at rest" is finally true.

### Security
- **The four secret columns on CoachSettings are encrypted on write and decrypted only at the point of use.** OpenAI and Anthropic keys are the live ones (read on every synopsis, brief, and embedding); the Stripe and Fathom-webhook columns are stored and protected but currently dormant — no code path reads them yet, so this change protects them at rest without implying Stripe traffic runs through the stored key.
- **A raw webhook signing secret stopped leaking in the Settings API response.** `fathomWebhookSecret` was returned unmasked to the browser via the response spread; it is now masked like every other secret. Every secret column the GET/PATCH response can emit is masked — the raw value never leaves the server after it is saved.
- **Reads tolerate the transition.** A not-yet-migrated plaintext row keeps working; an encrypted value that fails to decrypt (wrong key, tampering) fails loud on the AI path rather than calling a paid API with a garbage key. A one-shot backfill (`scripts/backfill-coach-settings-secrets.ts`) encrypts existing plaintext rows under a compare-and-swap so a concurrent save is never clobbered, and authenticates every existing envelope before it writes anything.

### Fixed
Found by the pre-merge review army, before any of it reached production:
- Saving a new key when the encryption key is misconfigured now returns a clear error instead of an opaque 500.
- Re-submitting an already-encrypted value no longer double-wraps it into an unusable key.
- The displayed mask is derived from one shared prefix, so the "don't re-save the mask" guard can't drift from the mask the API emits.

## [0.3.0.0] - 2026-07-20

The sales pipeline. CoachIQ now tracks who you're talking to before they become a client, so "lead → client → revenue" lives in one system instead of a tracker document nobody else can see. Deliberately manual: nothing here captures a prospect for you, because the team asked to trust the process before automating it.

### Added
- **Pipeline.** A new section listing every prospect — name, company, opportunity type, stage, days in stage, and what happens next. It opens sorted by neglect: prospects with nothing scheduled sit at the top, then the overdue, then everything on track. Opening the page answers "who am I forgetting" without touching a filter.
- **Adding prospects.** One at a time, or paste a whole tracker in. Only the name is required; company, what they need, and email are optional and fillable later. A company name containing a comma stays intact, and a paste straight out of Sheets works as-is.
- **Prospect dossier.** Who they are on the left, the full history on the right — every call, email and meeting logged, interleaved with every stage move. Marking a planned activity done immediately offers to schedule the next one, which is the only thing keeping a manual cadence alive.
- **Convert to client.** Winning a deal offers to create the client record, carrying their name, company, and what they need across, then drops you on the new client to set up billing. If that email already belongs to a client, it asks whether to link them rather than guessing.
- **Reports.** Hot Prospects (the stages you flag as hot, with the full activity detail Joel specified) and Pipeline Summary (count by stage, average age, average time in stage, average time since last contact). Statistics with no data render as an em-dash, never a zero — "0 days in stage" would claim nothing is sitting there when the truth is nothing is there.
- **Stage settings.** Rename, reorder, and flag stages as hot, so the team can name their own sales phases without a code change. Stages can't be added or removed: the won and lost stages drive the convert flow, and exactly one of each always exists.
- **Coach filter.** Owners and admins can view the whole practice or narrow to one coach, on both the list and the reports.

### Changed
- Clients gained a "description of need" field, populated when a prospect converts, so the reason they came to you survives into the coaching relationship.
- `ClientStatus.PROSPECT` is deprecated. Prospects are their own thing now, not clients wearing a different label — the client record carries billing machinery that is meaningless for a lead and dangerous if a cron ever treated one as billable.

### Fixed
Found by the pre-merge review, before any of it reached production:
- Creating a prospect directly in a won stage could mint a billable client without passing through the stage flow — no history, no audit trail.
- Reopening a closed prospect left it permanently claiming "none scheduled" while its own history showed a booked call.
- Closing a prospect didn't stick: later edits to any activity would resume the overdue nagging on a finished deal.
- Several edits in the dossier failed silently — a rejected save looked identical to a successful one, and the "plan next" prompt appeared even when marking done had failed.
- Repeat business hit a dead end: linking a returning client reported that a client "was just created" for a collision that was permanent.

## [0.2.0.0] - 2026-07-19

Multi-coach foundation. CoachIQ becomes a practice with more than one coach in it, rather than a single-user tool. Todd's experience is unchanged — everything that exists today belongs to him and behaves exactly as before — but the system now knows whose data is whose.

### Added
- **Coach accounts.** A Coaches section in Settings (owner and admin only) where adding a coach creates their account, emails them an invitation, and connects their Fathom recordings from an API key. The list shows what is actually live for each coach — signed in, Fathom connected, calendar configured — and offers a retry where something failed, so a half-finished setup can't sit there looking fine.
- **Adding clients.** Until now there was no way to add a client anywhere in the product; the existing ones came from a one-time import. Clients can now be added one at a time or by pasting a whole list, which is what onboarding a coach actually requires. New clients inherit their coach's default rate.
- **Roles.** Owner, admin, and coach. A coach sees only their own clients, sessions, invoices, and search results. Owners and admins see the whole practice and can filter to one coach.
- **Unmatched recordings are now a reviewable list** rather than a file dropped in Drive and a line in a log.

### Changed
- **Recordings find their own coach.** An incoming Fathom recording is matched to the coach who recorded it and verified against that coach's own signing secret, then matched to a client within that coach's book. Each coach connects their own Fathom account, calendar, and Drive folder.
- **The same person can be a client of two different coaches** without the two records colliding.
- Session titles are filtered by each coach's own pattern instead of one hard-coded rule, and the pattern is checked when it's saved rather than failing later.

### Fixed
- **Signing in no longer grants access to everything.** Previously any account that could sign in could read every client, transcript, and invoice; semantic search ranked across the entire practice regardless of who was asking. Access is now resolved per coach on every request, and an account with no coach record is told it has no access instead of being shown the practice.
- Several actions had no ownership check at all, including sending an invoice through Stripe.
- Alert colours now shift in dark mode. Error text was rendering at 3.62:1 contrast on the dark background, below the readable minimum.
- Neither dialog could be operated from a keyboard — no Escape, no focus handling. Both now can.
- The Clients page previously said clients were detected automatically from recordings, behind a button that did nothing. Neither was true.
- The Settings page said AI keys were encrypted at rest. They are not; only the new per-coach credentials are. The claim has been removed rather than the truth obscured.

### Security
- Per-coach Fathom credentials are encrypted at rest (AES-256-GCM) and never returned by any endpoint.
- Practice settings, including keys and the billing danger zone, are restricted to admins and above.
- Generating invoices, running a calendar sync, and testing the calendar connection all required nothing more than being signed in. All three now require admin, since each acts across the whole practice.

### Upgrading
- The Fathom signing secret moves from an environment variable onto the owner's coach record. Run `scripts/backfill-fathom-secret.ts` alongside the migration. If it hasn't run, incoming recordings fall back to the environment secret and log a notice rather than being rejected.

## [0.1.1.0] - 2026-07-19

### Changed
- Calendar sync and prep-brief delivery now run as one `workday-sync` cron, twice per weekday (12:00 and 18:00 UTC — 7am/1pm CDT) instead of two separate crons every 15 minutes. The database can now sleep between runs, cutting Neon compute usage by roughly 90% with no change to what Todd sees: sessions still sync before the workday and briefs are pre-generated ahead of every session.
- Prep briefs are pre-generated for all sessions in the upcoming half-day window (previously ~30 minutes before each session). The manual Generate Brief button still produces an on-demand brief at any time.
- Calendar sync now looks back 72 hours on every run, so Friday-afternoon and weekend sessions are always captured as billable time entries on Monday.
- Invoice generation moved to 12:05 UTC weekdays, right after calendar sync lands in the same Neon wake window. Weekdays-only on purpose: a Saturday or Sunday run would have invoiced weekend-due clients against a calendar that hadn't synced since Friday 1pm, silently missing Friday-afternoon sessions — those clients are now invoiced Monday, right after the weekend backlog sync.
- Brief delivery now also looks back one hour, so a cron run that fails or is cut short is re-covered by the next one (a session already underway still gets its brief) instead of that window's briefs being silently dropped — Vercel crons never retry.
- Cron runs now report `partial` (with per-item errors) when any individual calendar event or brief fails, instead of reporting a clean run.

### Fixed
- Cron endpoints now fail closed in production if `CRON_SECRET` is missing from the environment — previously they would have become publicly callable, including invoice generation. The check covers any production host (`NODE_ENV`), not just Vercel, and `CRON_SECRET` is now documented in `.env.example`.
- A stale client session counter can no longer silently suppress prep briefs — brief eligibility now rests solely on the client actually having recorded session history.
- The cron secret is now compared in constant time (hashed digests via `timingSafeEqual`), closing a theoretical timing side-channel on the only auth gate these public endpoints have.
- Calendar-only clients (sessions synced but never recorded, so no AI synopsis) no longer fail brief generation on every run forever — brief delivery now only considers clients with at least one synopsis-bearing session, keeping the `partial` cron status meaningful instead of permanently noisy.
- Brief delivery now detects a truncated calendar window via the API's `nextPageToken` rather than a page-length guess, so it neither misses briefs on a busy calendar nor false-alarms on an exactly-full page.
- Brief generation stops cleanly and reports remaining work if it approaches the function time limit, instead of being killed mid-run.

### Removed
- The `start-of-day` daily-brief pre-warm cron was unscheduled: its internal call targets the Clerk-protected `/api/daily-brief`, so it was redirected to sign-in and failed on every run — and there was no cache for a pre-warm to fill. The dashboard already generates the brief on open; a real pre-warm (cron auth + cache) is tracked in TODOS.

### Added
- Test coverage for the entire cron path: 50 new tests covering auth (fail-closed on Vercel and on any production host, constant-time comparison), window math and direction, failed-run recovery, client eligibility, dedup, failure isolation, error surfacing, and vercel.json↔schedule invariants for both crons (55 → 105 tests).
