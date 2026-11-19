-- UNDO for 20261119-1700-contracts-agreements-record.sql.
-- Drops the column. The record of what each signed contract contained is LOST (the signed PDFs are untouched); every contract then shows the name
-- it showed before the column existed. Run only if the column has to come off.

ALTER TABLE public.contracts DROP COLUMN IF EXISTS agreements;
