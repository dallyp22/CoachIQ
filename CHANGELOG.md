# Changelog

All notable changes to CoachIQ are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versions as MAJOR.MINOR.PATCH.MICRO.

## [0.6.0.0] - 2026-08-16

Feedback Phase 2/3. Phase 1 gave each coach a private tracker; this turns it into a shared roadmap and closes the loop back to the reporter. Coaches upvote what they want next, file a report from anywhere in the app, get a nudge when their item moves, and see everything that shipped.

### Added
- **Upvotes.** A vote button on every list card and board card — "me too / I want this". One vote per coach per item (enforced at the database), optimistic and instant. The Board sorts each stage column by votes, so demand is visible at a glance.
- **The Board is now the cross-coach roadmap.** Every coach sees every non-declined item by stage (a declined item stays visible only to whoever filed it). The List view stays each coach's own detailed tracker; an OWNER/ADMIN still sees everything in both.
- **Floating Report button** on every page (hidden on /feedback, which has its own). File a bug the moment you hit it — the modal captures the page you're on.
- **Unread badge.** The Feedback nav item shows a count (sidebar) / dot (mobile) when one of your reports has been acknowledged, moved, or replied to since you last looked. Opening /feedback clears it. For an owner it flags new reports and coach replies to triage.
- **What's New tab.** Everything that reached Shipped, newest first, grouped by version — so a coach who asked for something sees it land. Visible to everyone.

### Data
- `feedback_votes` (one row per coach per item; composite PK bars a double vote), `feedback_items.voteCount` (denormalized, recomputed inside the vote transaction so it can't drift), `coaches.feedbackLastSeenAt` (drives the unread badge). Migration `20260816_feedback_phase2`, already applied to the database.

### Chore
- The loose internal planning docs (`CoachIQ_*.md`, `ReferralGraph_*.md`, `AGENT_HANDOFF.md`) are now gitignored — kept local, never committed or deployed — and `.vercelignore` is tracked so that exclusion applies on Vercel.

## [0.5.2.0] - 2026-08-16

Feedback board + delete. Phase 1 shipped the per-item stage rail; this adds the pipeline-at-a-glance view and a way to remove items.

### Added
- **Board view on `/feedback`.** A List / Board toggle (a real URL, `?view=board`). Board lays out every item in columns by stage — Submitted through Shipped, plus Declined — each column with a colored stripe and a count. Cards are compact and click through to the item in List view where triage and the thread live. Columns scroll sideways in their own container; the page body never does. An OWNER/ADMIN sees all coaches' items by stage; a coach sees their own.
- **Delete a report.** A two-step inline confirm (no browser dialog) on each list card. `DELETE /api/feedback/[id]`: OWNER/ADMIN can delete any item, a COACH only their own. Stage history and comments cascade with it. A refusal answers 404, matching the prospect route — confirming an item exists but belongs to someone else is itself a disclosure.

## [0.5.1.0] - 2026-08-16

Feedback & Roadmap (Phase 1). A coach who hit a bug or wanted a feature had one channel: email Dallas, then hear nothing. Kurt's missing-appointments report is the case in point — it got fixed in 0.5.0.0, but he never saw it acknowledged or shipped. This adds an in-app page where any coach files a bug or feature request and then watches it move through the pipeline in the open — acknowledged, investigating, planned, in progress, shipped — with a reply from the CoachIQ team on the way. The point isn't ticket management for a five-person practice; it's follow-through the reporter can see.

### Added
- **`/feedback` page, for every coach.** A coach files a bug or feature request in a two-field modal (the page they were on, the app version, and their browser are captured automatically, so a plainly-worded report still arrives with the context to reproduce it) and sees each of their reports drawn on an animated **stage rail** — past stops filled, the live stop pulsing, future stops muted. A COACH sees only their own reports; OWNER/ADMIN sees every coach's.
- **Owner triage, inline.** OWNER/ADMIN can move an item's stage (which writes a dated history row the timeline reads), leave a short note the reporter sees, set priority, decline with a required reason, and link a GitHub issue as an optional mirror. The database stays the source of truth.
- **Team reply thread.** Any coach can reply on their own item; the owner replies as "CoachIQ Team" (a null-author comment) — the product speaking, not a named coach. This is the "sense of input" a status badge alone can't give.
- **Honest declines, submitter-only.** A declined request carries a public reason the reporter reads. Because a coach only ever sees their own items, a "no" never becomes a public wall.
- **Feedback nav item** in the sidebar and mobile nav, shown to everyone.
- **Seed script** (`scripts/seed-feedback.ts`, idempotent) loading the four real inbox items so the board opens with a working pipeline.

## [0.5.0.0] - 2026-08-06

Owner cockpit and view-as-coach. Kurt emailed that appointments were missing from his schedule. The cause: the calendar surfaced events by title keyword alone, so any real session titled plainly ("Kurt | Joel", "Melissa x Kurt") silently vanished. Fixing that opened the bigger gap — an owner could not see any coach's calendar or calendar health in the app at all, so a missing-appointment report meant running a script by hand. This release fixes the filter and gives Todd, as owner, a way to see each coach's schedule and setup status directly.

### Added
- **View-as-coach calendar.** An OWNER/ADMIN who selects a coach in the dashboard filter now sees that coach's live Google calendar, read-only (brief-generation actions hide). `/api/calendar/events` resolves the selected coach's calendar config instead of always the viewer's; the existing `scopeCoachId` boundary still blocks a COACH from viewing anyone else.
- **Practice page (OWNER/ADMIN only).** Two owner views in one place: a per-coach **Overview** leaderboard (active clients, sessions this week, hours this month, unbilled $), and **Calendar Health** — per coach, is a calendar connected, is sync on, is it reachable by the service account (a live probe that catches the #1 cause of missing appointments: a calendar never shared with CoachIQ), last synced session, and the effective title filter. Coach names link straight to their view-as-coach schedule.
- **Practice nav item** in the sidebar and mobile nav, shown only to OWNER/ADMIN.

### Changed
- **Coaching Schedule matches events by client, not just title.** An event now shows if its title matches the coaching filter OR a known client of that coach is on the invite. The billing sync still gates billable sessions on title alone, so a client-attended non-coaching meeting can appear on the schedule without ever minting an invoice.
- **The dashboard calendar no longer hides when a coach is selected** (reversing 0.4.0.0). It now shows the selected coach's schedule read-only, since the events API can scope to any coach.
- **A selected coach with no calendar connected shows a clear message** instead of a misleading empty "no sessions" day.

### Fixed
- **Appointments no longer silently disappear from the calendar** when their title lacks a coaching keyword. This was the reported bug: real client sessions titled plainly were dropped by a title-only regex filter.

## [0.4.0.0] - 2026-07-31

Admin coach-views. The data layer already let an owner or admin see every coach's book, but the UI had no coach dimension — a second coach's clients, sessions, and invoices were served into one merged list with no way to tell whose they were or to isolate them. This propagates the Pipeline module's proven coach filter to the rest of the app and adds a practice-wide Meetings view, so an admin can finally answer "what does Kurt's book look like?"

### Added
- **Coach filter + Coach column on Clients, Invoices, and the new Meetings page.** OWNER/ADMIN get an "All coaches / Todd / Kurt" selector (the same control the Pipeline already used, now shared) plus a Coach column so every row shows whose it is. A COACH sees neither — they only ever have their own book.
- **Meetings page.** A new practice-wide session feed across all coaches, filterable by coach, showing date, client, coach, source, and duration. Sessions previously lived only per-client and on the dashboard.
- **Dashboard KPIs filter by coach.** The stat cards and recent-sessions feed scope to All coaches or one coach.
- **Add Client routes to the right book.** Adding a client as an admin now asks which coach it belongs to (pre-selected when a coach is filtered), instead of silently landing it in the admin's own empty book.

### Changed
- **Invoice generation stays practice-wide but is honest about it.** The "Generate Draft Invoices" button now appears only in the All-coaches view; when filtered to one coach, the scoped unbilled total shows without the button, so a coach-filtered view can never trigger a practice-wide side effect.
- **The dashboard calendar/morning brief hide when a coach is selected.** They read the viewer's own calendar (singleton config) and can't yet be scoped to another coach, so they're hidden while filtered rather than contradicting the KPI cards above.

### Fixed
Found by the pre-merge review, before any of it shipped:
- A malformed `?coach=` URL param (hand-edited or stale) no longer 500s the page — a non-UUID value falls back to the whole-practice view instead of reaching a native uuid predicate. This guard covers every filtered surface at once.
- Coach attribution on draft invoice cards, so an admin can't approve or send the wrong coach's same-named client.
- The Coach column is driven by role, not the active roster, so an inactive coach's historical rows are still attributable.
- The Add Client rate hint no longer shows the admin's own default when adding to another coach's book.

### Notes
- Tenant isolation is unchanged and re-verified: `scopeCoachId` still ignores `?coach=` for a COACH, and the client-create endpoint still refuses a COACH-supplied `coachId`.
- Known follow-ups filed in TODOS.md: full per-coach dashboard calendar and coach-scoped invoice generation (both tangle with the pre-existing singleton calendar config), and Meetings in the mobile bottom nav.

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
