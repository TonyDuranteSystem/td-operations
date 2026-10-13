-- Go live "clean listing" (dev job ad09ea91): an old Drive record the cleaning did not keep is ARCHIVED (kept for staff, not listed, never shown).
-- Production's documents.status rule allows only pending/processed/classified/unclassified/error — 'archived' is added. Nothing is removed from the rule.
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'processed'::text, 'classified'::text, 'unclassified'::text, 'error'::text, 'archived'::text]));
