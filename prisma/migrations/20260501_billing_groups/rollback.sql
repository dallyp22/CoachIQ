-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK FOR BILLING GROUPS MIGRATION
-- ════════════════════════════════════════════════════════════════════════════
--
-- DANGER: This will fail if any invoices reference a group_id (groupId IS NOT
-- NULL). Run this only after voiding or reassigning all group-scoped invoices.
--
-- TO APPLY:
--   psql $DATABASE_URL -f prisma/migrations/20260501_billing_groups/rollback.sql
--   then:
--   npx prisma migrate resolve --rolled-back 20260501_billing_groups
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Refuse to roll back if group-scoped invoices exist.
DO $$
DECLARE
  group_invoice_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO group_invoice_count FROM invoices WHERE "groupId" IS NOT NULL;
  IF group_invoice_count > 0 THEN
    RAISE EXCEPTION 'Cannot roll back: % invoices reference a group_id. Void or reassign them first.', group_invoice_count;
  END IF;
END $$;

-- 4. billing_audit_logs.groupId
DROP INDEX IF EXISTS "billing_audit_logs_groupId_createdAt_idx";
ALTER TABLE "billing_audit_logs" DROP COLUMN IF EXISTS "groupId";

-- 3. invoices: drop CHECK, FK, index, column; restore clientId NOT NULL
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoice_billable_xor";
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_groupId_fkey";
DROP INDEX IF EXISTS "invoices_groupId_idx";
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "groupId";
-- Backfill any null clientId before re-adding NOT NULL (should be zero rows
-- since the DO block above ensured no group invoices exist).
ALTER TABLE "invoices" ALTER COLUMN "clientId" SET NOT NULL;

-- 2. clients.billingGroupId
ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "clients_billingGroupId_fkey";
DROP INDEX IF EXISTS "clients_billingGroupId_idx";
ALTER TABLE "clients" DROP COLUMN IF EXISTS "billingGroupId";

-- 1. billing_groups table
DROP TABLE IF EXISTS "billing_groups";

COMMIT;
