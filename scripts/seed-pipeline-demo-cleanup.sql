-- Remove every prospect seeded by scripts/seed-pipeline-demo.sql.
--
-- Matches on the `[demo]` tag in notes, which every seeded row carries. Activities
-- and stage-change history cascade (FK ON DELETE CASCADE), so this one statement
-- is the whole cleanup.
--
--     psql "$URL" -v ON_ERROR_STOP=1 -f scripts/seed-pipeline-demo-cleanup.sql
--
-- Touches NOTHING else: no clients, no sessions, no invoices, no stages. If a demo
-- prospect was converted to a client during the demo, that client is real and is
-- left alone — the DELETE below will refuse it rather than orphan the record, and
-- reports which rows were skipped.
BEGIN;

DO $$
DECLARE
    total      INT;
    converted  INT;
    removed    INT;
BEGIN
    SELECT COUNT(*) INTO total     FROM prospects WHERE notes LIKE '%[demo]%';
    SELECT COUNT(*) INTO converted FROM prospects WHERE notes LIKE '%[demo]%' AND "convertedToClientId" IS NOT NULL;

    DELETE FROM prospects WHERE notes LIKE '%[demo]%' AND "convertedToClientId" IS NULL;
    GET DIAGNOSTICS removed = ROW_COUNT;

    RAISE NOTICE 'demo prospects found: %, removed: %, kept (converted to a real client): %',
        total, removed, converted;

    IF converted > 0 THEN
        RAISE NOTICE 'The kept rows link to real Client records. Delete those clients first if they were also demo-only.';
    END IF;
END $$;

COMMIT;
