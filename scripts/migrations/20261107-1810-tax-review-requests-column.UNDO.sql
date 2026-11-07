-- UNDO for 20261107-1810-tax-review-requests-column.sql. Drops the requests field. The requests already sent stay in review_history
-- only as the usual "Changes requested" note (the per-answer text lives in this column and is lost).
ALTER TABLE public.tax_return_submissions DROP COLUMN IF EXISTS review_requests;
