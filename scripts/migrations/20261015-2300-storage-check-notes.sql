-- CRM Storage — "Storage check" notes (dev job ad09ea91, Antonio 2026-10-15). SANDBOX FIRST.
-- ONE new table, nothing existing is altered and nothing watches the busy tables.
--   kind 'left'      = a person was removed from a company by a CRM button (recorded just BEFORE the removal,
--                      because afterwards nothing says who was there); stays open until staff mark it seen.
--   kind 'dismissed' = staff said "this finding is not an issue" (key = the finding's key) so it stops showing.
-- Everything else the Storage check shows is computed live from the CRM and the storage — never stored.
BEGIN;

CREATE TABLE IF NOT EXISTS public.storage_check_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('left', 'dismissed')),
  key          text,
  contact_id   uuid,
  person_name  text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid
);

-- one open "left" note per company + person; one dismissal per company + finding
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_check_left_open
  ON public.storage_check_notes (account_id, contact_id) WHERE kind = 'left' AND resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_check_dismissed
  ON public.storage_check_notes (account_id, key) WHERE kind = 'dismissed';
CREATE INDEX IF NOT EXISTS idx_storage_check_account
  ON public.storage_check_notes (account_id) WHERE resolved_at IS NULL;

ALTER TABLE public.storage_check_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storage_check_notes FROM PUBLIC, anon, authenticated;

COMMIT;
