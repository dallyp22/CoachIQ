# Pipeline runtime tests

These hit a **real Postgres**. They are skipped by default so `npm test` stays
hermetic and offline.

```bash
# 1. A throwaway Neon branch off main (never point this at production —
#    the suites truncate prospects, activities and stage changes).
neonctl branches create --project-id winter-grass-89005980 \
  --name pipeline-tests-$(date +%Y%m%d) --parent main

# 2. Apply the pipeline migration to it.
psql "$URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20260719_pipeline_module/migration.sql

# 3. Run.
DATABASE_URL="$URL" npm run test:runtime

# 4. Delete the branch.
neonctl branches delete pipeline-tests-YYYYMMDD --project-id winter-grass-89005980
```

## Why they exist

`tests/lib/scoping-enforcement.test.ts` checks that a route *calls*
`requireCoach` — by its own header it "never asks what the file touches." A
route that authenticates and then runs `prisma.prospect.findMany({})` with no
where-clause passes it. That blindness is how `invoices/generate` and
`calendar/sync` shipped unscoped, and it was rewritten twice without closing.

So these do not test a proxy for isolation. They seed two coaches, call the
real handlers as each, and assert one cannot see or touch the other's rows.

| File | Proves |
|---|---|
| `scoping.runtime.test.ts` | No pipeline route leaks across coaches; a COACH sees rows they own **or** are assigned; role gates hold |
| `convert.runtime.test.ts` | The convert transaction — duplicate email, CHURNED match, link-existing, idempotency, and rollback |
| `next-activity.runtime.test.ts` | `nextActivityAt` survives every write path, including reschedule and terminal moves |

## Two things that will bite you

**`--no-file-parallelism` is required.** All three files share one database and
truncate in `beforeEach`. Run them in parallel and they delete each other's
fixtures — the failure looks like a scoping bug, which is maximally confusing.
The npm script sets it.

**A branch off `main` is a clone of production: 86 real clients live in it.**
Never assert on a bare `prisma.client.count()`. Scope to the suite's own rows
(`testClientCount()` filters on `@pipeline-test`). This already produced three
false failures.

## Keeping them honest

These were mutation-tested when written — each mutation was applied, the suite
run, and the mutation reverted:

| Mutation | Caught by |
|---|---|
| `prospectWhere` → ownership only | 4 tests |
| Drop `nulls: "first"` from `STALEST_FIRST` | 1 test |
| Omit `refreshNextActivityAt` from the PATCH path | 5 tests |

Do the same for anything added here. A test that cannot fail is worse than no
test — it reads as coverage.
