-- Feedback & Roadmap module: coach-submitted bugs / feature requests, the
-- stage history that drives the visible pipeline, and the comment thread.
--
-- HAND-WRITTEN, same reason as the pipeline + multi-coach migrations: `prisma
-- migrate dev` proposes DROPping transcripts.embedding and .search_text (both
-- raw-SQL-managed). This file touches nothing on "transcripts".
--
-- TRANSACTION: `prisma migrate deploy` wraps this file. The explicit
-- BEGIN/COMMIT makes an apply-by-hand psql run behave the same (all-or-nothing)
-- so the file stays re-runnable rather than half-applied.
BEGIN;

-- Ordering (a failure anywhere rolls back the whole thing):
--   1. enums
--   2. tables
--   3. foreign keys + indexes

-- ─── 1. Enums ─────────────────────────────────────────

CREATE TYPE "FeedbackType" AS ENUM ('BUG', 'FEATURE');
CREATE TYPE "FeedbackStage" AS ENUM (
    'SUBMITTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED'
);
CREATE TYPE "FeedbackPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- ─── 2. Tables ────────────────────────────────────────

CREATE TABLE "feedback_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "FeedbackType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "stage" "FeedbackStage" NOT NULL DEFAULT 'SUBMITTED',
    "priority" "FeedbackPriority",
    "submittedById" UUID NOT NULL,
    "pageUrl" TEXT,
    "appVersion" TEXT,
    "userAgent" TEXT,
    "ackAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "shippedInVersion" TEXT,
    "declineReason" TEXT,
    "githubUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "feedback_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "feedback_stage_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "feedbackId" UUID NOT NULL,
    "fromStage" "FeedbackStage",
    "toStage" "FeedbackStage" NOT NULL,
    "note" TEXT,
    "changedById" UUID,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_stage_changes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "feedback_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "feedbackId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id")
);

-- ─── 3. Foreign keys + indexes ────────────────────────

-- submitter: RESTRICT (default) — a coach with open reports should not be
-- silently deletable out from under them; the app soft-deletes coaches
-- (status INACTIVE) rather than removing the row.
ALTER TABLE "feedback_items"
    ADD CONSTRAINT "feedback_items_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "coaches"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- history + comments belong to the item: CASCADE, so deleting a feedback item
-- takes its trail with it.
ALTER TABLE "feedback_stage_changes"
    ADD CONSTRAINT "feedback_stage_changes_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "feedback_items"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "feedback_comments"
    ADD CONSTRAINT "feedback_comments_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "feedback_items"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- comment author: SET NULL — a removed coach's comments become "CoachIQ Team"
-- (null author) rather than blocking their removal or vanishing the thread.
ALTER TABLE "feedback_comments"
    ADD CONSTRAINT "feedback_comments_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "coaches"("id") ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX "feedback_items_stage_createdAt_idx" ON "feedback_items"("stage", "createdAt");
CREATE INDEX "feedback_items_submittedById_createdAt_idx" ON "feedback_items"("submittedById", "createdAt");
CREATE INDEX "feedback_stage_changes_feedbackId_changedAt_idx" ON "feedback_stage_changes"("feedbackId", "changedAt");
CREATE INDEX "feedback_comments_feedbackId_createdAt_idx" ON "feedback_comments"("feedbackId", "createdAt");

COMMIT;
