# TODOS

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

## Phase 4 Bugs

### NLM retry_failed.py is broken
**What:** `coachiq/cron/retry_failed.py` has a TODO — it increments the retry counter but never actually re-fetches the transcript or re-attempts the NLM injection. Failed injections are silently dropped after 10 "retries."
**Why:** This means NLM injection failures are never recovered. In v3, the NLM worker moves to a Fly.io container and retries against PostgreSQL, so the fix looks different, but the bug should be addressed during the Phase 4 NLM worker rebuild.
**Depends on:** Phase 4 NLM worker migration.
**Added:** 2026-03-28 via /plan-eng-review
