-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CHURNED', 'PROSPECT');

-- CreateEnum
CREATE TYPE "BillingCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "MeetingCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'AD_HOC');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('CAPTURED', 'REVIEWED', 'BILLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TimeEntryStatus" AS ENUM ('UNBILLED', 'STAGED', 'INVOICED', 'PAID', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SENT', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('GENERATE_EMBEDDING', 'GENERATE_SYNOPSIS', 'GENERATE_BRIEF', 'INJECT_NLM');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "secondaryEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phone" TEXT,
    "company" TEXT,
    "address" JSONB,
    "hourlyRate" DECIMAL(10,2) NOT NULL DEFAULT 300,
    "billingCadence" "BillingCadence" NOT NULL DEFAULT 'MONTHLY',
    "meetingCadence" "MeetingCadence" NOT NULL DEFAULT 'BIWEEKLY',
    "stripeCustomerId" TEXT,
    "notebookId" TEXT,
    "driveFolderId" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "fathomRecordingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "billableMinutes" INTEGER NOT NULL,
    "recordingUrl" TEXT,
    "shareUrl" TEXT,
    "fathomSummary" TEXT,
    "actionItems" JSONB,
    "synopsis" TEXT,
    "transcriptDriveId" TEXT,
    "nlmInjected" BOOLEAN NOT NULL DEFAULT false,
    "calendarEventId" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'CAPTURED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "fullText" TEXT NOT NULL,
    "rawSegments" JSONB,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "speakerStats" JSONB,
    "embeddingModel" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID,
    "clientId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "billableHours" DECIMAL(5,2) NOT NULL,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "status" "TimeEntryStatus" NOT NULL DEFAULT 'UNBILLED',
    "invoiceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "lineItems" JSONB NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "tax" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "stripeInvoiceId" TEXT,
    "stripePaymentUrl" TEXT,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prep_briefs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "targetSessionDate" TIMESTAMP(3) NOT NULL,
    "content" TEXT NOT NULL,
    "contextSessions" UUID[] DEFAULT ARRAY[]::UUID[],
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coachName" TEXT NOT NULL DEFAULT 'Todd Zimbelman',
    "coachEmail" TEXT NOT NULL DEFAULT 'todd@growwithcocreate.com',
    "businessName" TEXT NOT NULL DEFAULT 'Co-Create Coaching',
    "defaultHourlyRate" DECIMAL(10,2) NOT NULL DEFAULT 300,
    "defaultBillingCadence" "BillingCadence" NOT NULL DEFAULT 'MONTHLY',
    "billingDayOfWeek" INTEGER NOT NULL DEFAULT 1,
    "stripeAccountId" TEXT,
    "googleCalendarId" TEXT,
    "fathomWebhookSecret" TEXT,
    "coachingTitleFilter" TEXT,
    "briefDeliveryMinutes" INTEGER NOT NULL DEFAULT 30,
    "nlmLastSynced" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "JobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_email_key" ON "clients"("email");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE INDEX "clients_email_idx" ON "clients"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_fathomRecordingId_key" ON "sessions"("fathomRecordingId");

-- CreateIndex
CREATE INDEX "sessions_clientId_date_idx" ON "sessions"("clientId", "date" DESC);

-- CreateIndex
CREATE INDEX "sessions_fathomRecordingId_idx" ON "sessions"("fathomRecordingId");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_sessionId_key" ON "transcripts"("sessionId");

-- CreateIndex
CREATE INDEX "transcripts_clientId_createdAt_idx" ON "transcripts"("clientId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "time_entries_sessionId_key" ON "time_entries"("sessionId");

-- CreateIndex
CREATE INDEX "time_entries_clientId_status_idx" ON "time_entries"("clientId", "status");

-- CreateIndex
CREATE INDEX "time_entries_status_idx" ON "time_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "invoices_clientId_idx" ON "invoices"("clientId");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "prep_briefs_clientId_targetSessionDate_idx" ON "prep_briefs"("clientId", "targetSessionDate");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_type_status_idx" ON "jobs"("type", "status");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prep_briefs" ADD CONSTRAINT "prep_briefs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
