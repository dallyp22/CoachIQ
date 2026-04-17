-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK for 20260416_billing_overhaul
-- Apply only if you need to revert. Manual: psql $DATABASE_URL -f rollback.sql
-- Note: Snapshot data and audit log entries created post-migration WILL BE LOST.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Sequences (drop only the current year's; older years retained if any)
DO $$
DECLARE y INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
BEGIN
  EXECUTE format('DROP SEQUENCE IF EXISTS invoice_number_seq_%s', y);
END $$;
DROP FUNCTION IF EXISTS ensure_invoice_seq_for_year(INTEGER);

-- New tables
DROP TABLE IF EXISTS billing_audit_logs;
DROP TABLE IF EXISTS invoice_adjustments;

-- Invoice snapshot fields
ALTER TABLE invoices
  DROP COLUMN IF EXISTS "lastReminderSentAt",
  DROP COLUMN IF EXISTS "parentInvoiceId",
  DROP COLUMN IF EXISTS "snapshotHourlyRate",
  DROP COLUMN IF EXISTS "snapshotBillingCcEmails",
  DROP COLUMN IF EXISTS "snapshotBillingEmail",
  DROP COLUMN IF EXISTS "snapshotClientName";

-- Coach settings
ALTER TABLE coach_settings
  ADD COLUMN "billingDayOfWeek" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coach_settings
  DROP CONSTRAINT IF EXISTS coach_settings_defaultBillingDayOfMonth_range,
  DROP COLUMN IF EXISTS "timezone",
  DROP COLUMN IF EXISTS "invoiceNumberPadding",
  DROP COLUMN IF EXISTS "invoicePrefix",
  DROP COLUMN IF EXISTS "autoApproveUnderCents",
  DROP COLUMN IF EXISTS "defaultBillingDayOfMonth";

-- Client additions
ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_customCadenceDays_range;
DROP INDEX IF EXISTS clients_nextInvoiceDueAt_idx;
ALTER TABLE clients
  DROP COLUMN IF EXISTS "retainer",
  DROP COLUMN IF EXISTS "billingTimezone",
  DROP COLUMN IF EXISTS "nextInvoiceDueAt",
  DROP COLUMN IF EXISTS "billingNotes",
  DROP COLUMN IF EXISTS "billingPausedUntil",
  DROP COLUMN IF EXISTS "billingContactEmail",
  DROP COLUMN IF EXISTS "billingContactName",
  DROP COLUMN IF EXISTS "customCadenceDays",
  DROP COLUMN IF EXISTS "displayName";

-- SessionStatus: re-add BILLED
ALTER TYPE "SessionStatus" RENAME TO "SessionStatus_old";
CREATE TYPE "SessionStatus" AS ENUM ('CAPTURED', 'REVIEWED', 'BILLED', 'ARCHIVED');
ALTER TABLE sessions
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE "SessionStatus" USING status::text::"SessionStatus",
  ALTER COLUMN status SET DEFAULT 'CAPTURED';
DROP TYPE "SessionStatus_old";
-- Note: rows that were BILLED then migrated to ARCHIVED stay ARCHIVED.
-- Original BILLED state cannot be recovered.

-- BillingCadence: cannot drop CUSTOM_DAYS enum value if any rows use it.
-- Manual cleanup required:
--   UPDATE clients SET billingCadence = 'MONTHLY' WHERE billingCadence = 'CUSTOM_DAYS';
--   then run the swap-rebuild pattern (omitted here — only do this if needed).

COMMIT;
