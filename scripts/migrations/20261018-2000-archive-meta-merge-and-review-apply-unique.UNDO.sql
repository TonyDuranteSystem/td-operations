-- UNDO for 20261018-2000-archive-meta-merge-and-review-apply-unique.sql
DROP FUNCTION IF EXISTS public.archive_meta_merge(text, uuid, jsonb);
DROP INDEX IF EXISTS public.uq_job_queue_tax_review_apply;
