-- Feedback Phase 2: upvotes + unread tracking.
--   - feedback_votes: one row per (item, coach); composite PK bars a double vote.
--   - feedback_items.voteCount: denormalized tally kept in step inside the vote txn.
--   - coaches.feedbackLastSeenAt: drives the unread badge.
--
-- HAND-WRITTEN (same reason as the prior feedback migration): `prisma migrate
-- dev` proposes DROPping transcripts.embedding / .search_text (raw-SQL-managed).
-- This file touches neither.
--
-- TRANSACTION: `prisma migrate deploy` wraps this file; the explicit BEGIN/COMMIT
-- makes an apply-by-hand psql run behave the same (all-or-nothing).
BEGIN;

-- ─── 1. Columns ───────────────────────────────────────

ALTER TABLE "feedback_items" ADD COLUMN "voteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "coaches" ADD COLUMN "feedbackLastSeenAt" TIMESTAMP(3);

-- ─── 2. Votes table ───────────────────────────────────

CREATE TABLE "feedback_votes" (
    "feedbackId" UUID NOT NULL,
    "coachId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_votes_pkey" PRIMARY KEY ("feedbackId", "coachId")
);

ALTER TABLE "feedback_votes"
    ADD CONSTRAINT "feedback_votes_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "feedback_items"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "feedback_votes"
    ADD CONSTRAINT "feedback_votes_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "coaches"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "feedback_votes_coachId_idx" ON "feedback_votes"("coachId");

-- ─── 3. Board sort index ──────────────────────────────

CREATE INDEX "feedback_items_stage_voteCount_idx" ON "feedback_items"("stage", "voteCount");

COMMIT;
