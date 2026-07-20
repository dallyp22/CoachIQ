-- Multi-coach foundation: Coach + PendingRecording tables, coach ownership on
-- clients and billing groups.
--
-- HAND-WRITTEN ON PURPOSE. `prisma migrate dev` proposes DROPping
-- transcripts.embedding (602+ rows of paid embeddings) and
-- transcripts.search_text because they are raw-SQL-managed. Those columns are
-- now declared as Unsupported() in schema.prisma so the differ sees them, but
-- this file still touches nothing on "transcripts".
--
-- TRANSACTION: `prisma migrate deploy` wraps this file in one transaction.
-- Applying it by hand with psql does NOT — psql commits each statement
-- separately, which would make the invariant checks at the bottom decorative
-- (they would RAISE after everything before them had already committed, and
-- the file cannot be re-run because CREATE TYPE would fail). The explicit
-- BEGIN/COMMIT below makes the by-hand path behave like the Prisma path.
-- Prisma tolerates the redundant wrapper.
BEGIN;

-- Ordering (a failure anywhere rolls the entire thing back, so there is no
-- half-migrated state):
--   1. enums + new tables
--   2. seed the OWNER (from coach_settings) and the ADMIN
--   3. add coachId nullable → backfill to OWNER → SET NOT NULL → FK + index
--   4. swap clients.email global-unique for (coachId, email)
--   5. assert invariants
--
-- Group membership rule (one coach per BillingGroup, every member sharing it)
-- is enforced in the application at member-add, not by a trigger.

-- ─── 1. Enums and tables ──────────────────────────────

CREATE TYPE "CoachRole" AS ENUM ('OWNER', 'ADMIN', 'COACH');
CREATE TYPE "CoachStatus" AS ENUM ('INVITED', 'ACTIVE', 'INACTIVE');
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'OK', 'FAILED');

CREATE TABLE "coaches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "loginEmail" TEXT NOT NULL,
    "workEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clerkUserId" TEXT,
    "role" "CoachRole" NOT NULL DEFAULT 'COACH',
    "status" "CoachStatus" NOT NULL DEFAULT 'INVITED',
    "inviteStatus" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "fathomStatus" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "fathomApiKey" TEXT,
    "fathomWebhookSecret" TEXT,
    "fathomWebhookId" TEXT,
    "googleCalendarId" TEXT,
    "coachingTitleFilter" TEXT,
    "calendarSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "driveRootFolderId" TEXT,
    "defaultHourlyRate" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coaches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coaches_loginEmail_key" ON "coaches"("loginEmail");
CREATE UNIQUE INDEX "coaches_clerkUserId_key" ON "coaches"("clerkUserId");
CREATE INDEX "coaches_status_idx" ON "coaches"("status");

CREATE TABLE "pending_recordings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coachId" UUID NOT NULL,
    "fathomRecordingId" TEXT NOT NULL,
    "inviteeEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "driveFileId" TEXT,
    "title" TEXT,
    "recordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "pending_recordings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_recordings_coachId_fathomRecordingId_key" ON "pending_recordings"("coachId", "fathomRecordingId");
CREATE INDEX "pending_recordings_coachId_resolvedAt_idx" ON "pending_recordings"("coachId", "resolvedAt");

ALTER TABLE "pending_recordings" ADD CONSTRAINT "pending_recordings_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "coaches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 2. Seed the existing practice ────────────────────

-- Todd becomes OWNER, inheriting the singleton's identity and calendar config.
-- coachEmail seeds workEmails too: today it is both his login and the address
-- his recordings and calendar events come from.
INSERT INTO "coaches" (
    "name", "loginEmail", "workEmails", "role", "status",
    "inviteStatus", "fathomStatus",
    "googleCalendarId", "coachingTitleFilter", "calendarSyncEnabled",
    "defaultHourlyRate", "updatedAt"
)
SELECT
    COALESCE(NULLIF(TRIM(cs."coachName"), ''), 'Todd Zimbelman'),
    LOWER(COALESCE(NULLIF(TRIM(cs."coachEmail"), ''), 'todd@growwithcocreate.com')),
    ARRAY[LOWER(COALESCE(NULLIF(TRIM(cs."coachEmail"), ''), 'todd@growwithcocreate.com'))],
    'OWNER', 'ACTIVE', 'OK', 'OK',
    cs."googleCalendarId",
    cs."coachingTitleFilter",
    cs."calendarSyncEnabled",
    cs."defaultHourlyRate",
    CURRENT_TIMESTAMP
FROM "coach_settings" cs
ORDER BY cs."createdAt" ASC
LIMIT 1;

-- Fresh database with no settings row yet: still needs an OWNER to hang
-- everything off.
INSERT INTO "coaches" (
    "name", "loginEmail", "workEmails", "role", "status",
    "inviteStatus", "fathomStatus", "calendarSyncEnabled", "defaultHourlyRate", "updatedAt"
)
SELECT
    'Todd Zimbelman', 'todd@growwithcocreate.com', ARRAY['todd@growwithcocreate.com'],
    'OWNER', 'ACTIVE', 'OK', 'OK', false, 300, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "coaches" WHERE "role" = 'OWNER');

-- ADMIN accounts are NOT seeded here. Clerk auth is presence-only until this
-- deploys, so every account that can sign in today works; afterwards only
-- seeded coaches do. Anyone who currently uses CoachIQ and is not Todd must
-- get a row, or they hit the no-access screen.
--
<<<<<<< Updated upstream
-- Both addresses are verified against the live Clerk user list (2026-07-19):
-- admin-one@example.com and admin-two@example.com are real accounts
-- that can sign in today. Seeding only one would lock the other out.
-- Joel and other management are added through the Add Coach flow (role ADMIN).
INSERT INTO "coaches" (
    "name", "loginEmail", "role", "status",
    "inviteStatus", "fathomStatus", "calendarSyncEnabled", "updatedAt"
)
VALUES
    ('Practice Admin One', 'admin-one@example.com', 'ADMIN', 'ACTIVE', 'OK', 'OK', false, CURRENT_TIMESTAMP),
    ('Practice Admin Two', 'admin-two@example.com', 'ADMIN', 'ACTIVE', 'OK', 'OK', false, CURRENT_TIMESTAMP)
ON CONFLICT ("loginEmail") DO NOTHING;
=======
-- Those addresses are personal and this repository is public, so they are
-- supplied at run time instead of committed:
--
--   COACHIQ_ADMIN_EMAILS="a@example.com,b@example.com" \
--     npx tsx scripts/seed-admin-coaches.ts
--
-- Run it in the same session as the migration. Joel and other management are
-- added afterwards through the Add Coach flow.
>>>>>>> Stashed changes

-- ─── 3. Coach ownership on clients ────────────────────

ALTER TABLE "clients" ADD COLUMN "coachId" UUID;

UPDATE "clients"
SET "coachId" = (SELECT "id" FROM "coaches" WHERE "role" = 'OWNER' ORDER BY "createdAt" ASC LIMIT 1)
WHERE "coachId" IS NULL;

ALTER TABLE "clients" ALTER COLUMN "coachId" SET NOT NULL;

ALTER TABLE "clients" ADD CONSTRAINT "clients_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "coaches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "clients_coachId_idx" ON "clients"("coachId");

-- Client email becomes unique per coach, not globally: two coaches may serve
-- the same person, and recording→client matching is coach-scoped by then.
DROP INDEX "clients_email_key";
CREATE UNIQUE INDEX "clients_coachId_email_key" ON "clients"("coachId", "email");

-- ─── 4. Coach ownership on billing groups ─────────────

ALTER TABLE "billing_groups" ADD COLUMN "coachId" UUID;

UPDATE "billing_groups"
SET "coachId" = (SELECT "id" FROM "coaches" WHERE "role" = 'OWNER' ORDER BY "createdAt" ASC LIMIT 1)
WHERE "coachId" IS NULL;

ALTER TABLE "billing_groups" ALTER COLUMN "coachId" SET NOT NULL;

ALTER TABLE "billing_groups" ADD CONSTRAINT "billing_groups_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "coaches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "billing_groups_coachId_idx" ON "billing_groups"("coachId");

-- ─── 5. Invariants ────────────────────────────────────

DO $$
DECLARE
    owner_count INT;
    mixed_groups INT;
BEGIN
    SELECT COUNT(*) INTO owner_count FROM "coaches" WHERE "role" = 'OWNER';
    IF owner_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 OWNER coach after seeding, found %', owner_count;
    END IF;

    -- Every existing group and its members landed on the same coach.
    SELECT COUNT(*) INTO mixed_groups
    FROM "billing_groups" g
    JOIN "clients" c ON c."billingGroupId" = g."id"
    WHERE c."coachId" <> g."coachId";
    IF mixed_groups > 0 THEN
        RAISE EXCEPTION 'Found % billing group member(s) whose coach differs from the group coach', mixed_groups;
    END IF;
END $$;

COMMIT;
