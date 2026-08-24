-- migration:20260821-0100-portal-translations-nullable-text.sql
-- ============================================================================
-- Fix a real gap in the original portal_translations schema (dev job
-- 12cab351), found while building the actual generation pipeline: a row
-- claimed at 'pending' status genuinely has no translated text yet — the
-- whole point of 'pending' is "reserved, not generated." NOT NULL forced an
-- awkward empty-string placeholder at claim time, which risks an empty
-- string silently being served as if it were a real (blank) translation if
-- a status check is ever missed somewhere downstream. Caught before any
-- real content or any production use — the table is still empty.
-- ============================================================================

ALTER TABLE public.portal_translations
  ALTER COLUMN translated_text DROP NOT NULL;

COMMENT ON COLUMN public.portal_translations.translated_text IS
  'NULL until status=''done''. A pending/generating row is a claim, not a translation — callers must check status, never assume a non-null value from a bare SELECT alone. Dev job 12cab351.';
