-- UNDO for 20261028-1700-ss4-archive-and-resubmit.sql.
-- Only safe while the archive is empty (otherwise the archived SS-4s are lost) — the guard below refuses otherwise.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ss4_applications_archive) THEN
    RAISE EXCEPTION 'ss4_applications_archive has rows — restore them first';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.resubmit_ss4(uuid, text, text, jsonb);
DROP TABLE IF EXISTS public.ss4_applications_archive;
