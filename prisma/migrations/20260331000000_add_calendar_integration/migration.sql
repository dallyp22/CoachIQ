-- CreateEnum
CREATE TYPE "SessionSource" AS ENUM ('FATHOM', 'CALENDAR', 'MANUAL');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'CALENDAR_SYNC';

-- AlterTable: clients
ALTER TABLE "clients" ADD COLUMN "allowsFathom" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: coach_settings
ALTER TABLE "coach_settings" ADD COLUMN "calendarSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: sessions
ALTER TABLE "sessions" ADD COLUMN "sessionSource" "SessionSource" NOT NULL DEFAULT 'FATHOM',
ALTER COLUMN "fathomRecordingId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_calendarEventId_key" ON "sessions"("calendarEventId");
