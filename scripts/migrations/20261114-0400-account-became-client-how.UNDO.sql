-- UNDO for 20261114-0400-account-became-client-how.sql (drops the three columns and the guard; the confirmed answers are lost)
DROP TRIGGER IF EXISTS trg_accounts_became_client_how_guard ON public.accounts;
DROP FUNCTION IF EXISTS public.guard_accounts_became_client_how();
ALTER TABLE public.accounts
  DROP COLUMN IF EXISTS became_client_how_checked_by,
  DROP COLUMN IF EXISTS became_client_how_checked_at,
  DROP COLUMN IF EXISTS became_client_how;
