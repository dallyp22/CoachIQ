-- Pipeline module: prospects, activities, stage history, stage lookup.
--
-- HAND-WRITTEN, same reason as 20260719_multi_coach_foundation: `prisma
-- migrate dev` proposes DROPping transcripts.embedding (711 rows of paid
-- embeddings) and transcripts.search_text because both are raw-SQL-managed.
-- This file touches nothing on "transcripts".
--
-- TRANSACTION: `prisma migrate deploy` wraps this file. Applying it by hand
-- with psql does NOT — psql commits per statement, which would make the
-- invariant checks at the bottom decorative and leave the file un-re-runnable
-- (CREATE TYPE would fail on a retry). The explicit BEGIN/COMMIT makes the
-- by-hand path behave like the Prisma path; Prisma tolerates the wrapper.
BEGIN;

-- Ordering (a failure anywhere rolls back the whole thing):
--   1. enums
--   2. tables
--   3. clients.needSummary
--   4. foreign keys + indexes
--   5. seed placeholder stages
--   6. assert invariants

-- ─── 1. Enums ─────────────────────────────────────────

CREATE TYPE "StageOutcome" AS ENUM ('WON', 'LOST');
CREATE TYPE "OpportunityType" AS ENUM ('COACHING', 'FACILITATION', 'IMPLEMENTATION', 'MULTIPLE');
CREATE TYPE "ProspectSource" AS ENUM ('MANUAL', 'EMAIL_INTAKE', 'REFERRAL_GRAPH');
CREATE TYPE "ActivityKind" AS ENUM ('LOGGED', 'PLANNED');

-- ─── 2. Tables ────────────────────────────────────────

CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isHot" BOOLEAN NOT NULL DEFAULT false,
    "terminal" "StageOutcome",
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- The rule that makes convert-to-client safe: at most ONE live stage per
-- terminal outcome. Stages are editable rows, so without this the convert
-- trigger can end up with two WON stages or none. Partial, so any number of
-- ARCHIVED terminal stages may linger holding historical prospects.
CREATE UNIQUE INDEX "pipeline_stages_one_live_per_terminal"
    ON "pipeline_stages"("terminal")
    WHERE "terminal" IS NOT NULL AND "isArchived" = false;

CREATE INDEX "pipeline_stages_sortOrder_idx" ON "pipeline_stages"("sortOrder");

CREATE TABLE "prospects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coachId" UUID NOT NULL,
    "assignedCoachId" UUID,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "company" TEXT,
    "opportunityType" "OpportunityType" NOT NULL DEFAULT 'COACHING',
    "needSummary" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "source" "ProspectSource" NOT NULL DEFAULT 'MANUAL',
    "stageId" UUID NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextActivityAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "notes" TEXT,
    "convertedToClientId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pipeline_activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prospectId" UUID NOT NULL,
    "kind" "ActivityKind" NOT NULL,
    "activityAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "ownerId" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pipeline_activities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prospect_stage_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prospectId" UUID NOT NULL,
    "fromStageId" UUID,
    "toStageId" UUID NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedById" UUID,
    CONSTRAINT "prospect_stage_changes_pkey" PRIMARY KEY ("id")
);

-- ─── 3. Client gains the converted "description of need" ──

ALTER TABLE "clients" ADD COLUMN "needSummary" TEXT;

-- ─── 4. Foreign keys and indexes ──────────────────────

-- RESTRICT on both coach columns: coaches are soft-removed (status INACTIVE),
-- never deleted, so this should be unreachable — it is here to keep it that
-- way rather than silently orphaning a lead.
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "coaches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_assignedCoachId_fkey"
    FOREIGN KEY ("assignedCoachId") REFERENCES "coaches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- RESTRICT is what actually blocks deleting a stage that still holds
-- prospects; the archive guard in the app is the friendly version of this.
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_convertedToClientId_fkey"
    FOREIGN KEY ("convertedToClientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "prospects_convertedToClientId_key" ON "prospects"("convertedToClientId");
CREATE INDEX "prospects_coachId_idx" ON "prospects"("coachId");
CREATE INDEX "prospects_assignedCoachId_idx" ON "prospects"("assignedCoachId");
CREATE INDEX "prospects_stageId_idx" ON "prospects"("stageId");
CREATE INDEX "prospects_nextActivityAt_idx" ON "prospects"("nextActivityAt");

ALTER TABLE "pipeline_activities" ADD CONSTRAINT "pipeline_activities_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_activities" ADD CONSTRAINT "pipeline_activities_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "coaches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pipeline_activities_prospectId_activityAt_idx"
    ON "pipeline_activities"("prospectId", "activityAt");
-- Serves the "soonest incomplete PLANNED activity" lookup that rebuilds
-- prospects.nextActivityAt after every activity mutation.
CREATE INDEX "pipeline_activities_next_lookup_idx"
    ON "pipeline_activities"("prospectId", "kind", "completedAt", "activityAt");

ALTER TABLE "prospect_stage_changes" ADD CONSTRAINT "prospect_stage_changes_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "prospect_stage_changes_prospectId_changedAt_idx"
    ON "prospect_stage_changes"("prospectId", "changedAt");

-- ─── 5. Seed placeholder stages ───────────────────────

-- Placeholders. Joel/Todd/Kurt have NOT finalized these (PRD §10.1), which is
-- exactly why Settings ships with rename / reorder / isHot: correcting them is
-- an edit, not a migration. isHot from "Discovery Scheduled" onward is a guess.
INSERT INTO "pipeline_stages" ("name", "sortOrder", "isHot", "terminal", "updatedAt") VALUES
    ('New Lead',                1, false, NULL,   CURRENT_TIMESTAMP),
    ('Contacted',               2, false, NULL,   CURRENT_TIMESTAMP),
    ('Discovery Scheduled',     3, true,  NULL,   CURRENT_TIMESTAMP),
    ('Proposal / In Discussion',4, true,  NULL,   CURRENT_TIMESTAMP),
    ('Verbal Commit',           5, true,  NULL,   CURRENT_TIMESTAMP),
    ('Closed-Won',              6, false, 'WON',  CURRENT_TIMESTAMP),
    ('Closed-Lost',             7, false, 'LOST', CURRENT_TIMESTAMP);

-- ─── 6. Invariants ────────────────────────────────────

DO $$
DECLARE
    live_won  INT;
    live_lost INT;
    open_stages INT;
BEGIN
    SELECT COUNT(*) INTO live_won
    FROM "pipeline_stages" WHERE "terminal" = 'WON' AND "isArchived" = false;
    IF live_won <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 live WON stage after seeding, found %', live_won;
    END IF;

    SELECT COUNT(*) INTO live_lost
    FROM "pipeline_stages" WHERE "terminal" = 'LOST' AND "isArchived" = false;
    IF live_lost <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 live LOST stage after seeding, found %', live_lost;
    END IF;

    -- A prospect has to be able to land somewhere that is not already closed.
    SELECT COUNT(*) INTO open_stages
    FROM "pipeline_stages" WHERE "terminal" IS NULL AND "isArchived" = false;
    IF open_stages < 1 THEN
        RAISE EXCEPTION 'Expected at least 1 open (non-terminal) stage after seeding, found %', open_stages;
    END IF;
END $$;

COMMIT;
