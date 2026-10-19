-- Stop Drive S1c round 5 (dev job 264bb882).
-- 1) ONE tax "review apply" job per submission, enforced by the database: two near-simultaneous tax_form_review clicks both try to
--    enqueue it; the second insert fails with a unique violation and the code treats that as "already applied". A failed or
--    cancelled job leaves the index (status filter), so a re-run after a real failure can enqueue again.
-- 2) archive_meta_merge: merge a patch into drive_archive_meta ATOMICALLY (jsonb ||), so the sweep's "alerted" flag and an archive
--    attempt record can never overwrite each other with a stale copy. The code falls back to read-merge-write when this function
--    is missing, so the code is safe to deploy before or after this migration.
-- Safe to re-run (IF NOT EXISTS / OR REPLACE). UNDO: 20261018-2000-archive-meta-merge-and-review-apply-unique.UNDO.sql

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_queue_tax_review_apply
  ON public.job_queue ((related_entity_id))
  WHERE job_type = 'tax_form_setup'
    AND (payload ->> 'review_apply') = 'true'
    AND status IN ('pending', 'processing', 'completed');

CREATE OR REPLACE FUNCTION public.archive_meta_merge(p_table text, p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_table NOT IN ('tax_return_submissions', 'banking_submissions', 'itin_submissions', 'closure_submissions', 'formation_submissions', 'onboarding_submissions') THEN
    RAISE EXCEPTION 'archive_meta_merge: table % is not allowed', p_table;
  END IF;
  EXECUTE format(
    'UPDATE public.%I SET drive_archive_meta = COALESCE(drive_archive_meta, ''{}''::jsonb) || $1 WHERE id = $2',
    p_table
  ) USING p_patch, p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_meta_merge(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_meta_merge(text, uuid, jsonb) TO service_role;
