# Changelog

All notable changes to CoachIQ are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versions as MAJOR.MINOR.PATCH.MICRO.

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
