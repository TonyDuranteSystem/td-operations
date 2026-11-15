-- Account field: "How they became our client" = Formed by us | Onboarded   (dev job 5ea6c651, child of 23abd800)
--
-- Why: the yearly invoices (January + June) depend on WHEN a company became our client and on whether we FORMED it or ONBOARDED it
-- (it already existed). Both come from the offer / contract type; the date is the day the contract was signed. Today nothing on the
-- account says which one it is, so it is guessed from Client Since. This adds the answer as its own field, pre-filled with a guess that
-- a person confirms company by company.
--
--   became_client_how             'formed_by_us' | 'onboarded'   (NULL = not set)
--   became_client_how_checked_at  when a person confirmed it (NULL = still a guess: shown as "To check")
--   became_client_how_checked_by  who ("dashboard:<name>")
--
-- The two allowed values are guarded by a TRIGGER, not a CHECK: a value-list CHECK on the shared sandbox database is reported as an
-- unregistered rule and turns every other session's CI red until the code registers it (reference note 2026-10-26).
-- Nothing in billing reads these columns yet.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS became_client_how text,
  ADD COLUMN IF NOT EXISTS became_client_how_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS became_client_how_checked_by text;

COMMENT ON COLUMN public.accounts.became_client_how IS
  'How the company became our client: formed_by_us (we formed it) or onboarded (it already existed). NULL = not set. Guessed first, confirmed by a person (became_client_how_checked_at).';
COMMENT ON COLUMN public.accounts.became_client_how_checked_at IS
  'When a person confirmed became_client_how. NULL while the value is only a guess.';
COMMENT ON COLUMN public.accounts.became_client_how_checked_by IS
  'Who confirmed became_client_how (dashboard:<name>).';

CREATE OR REPLACE FUNCTION public.guard_accounts_became_client_how()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.became_client_how IS NOT NULL AND NEW.became_client_how NOT IN ('formed_by_us', 'onboarded') THEN
    RAISE EXCEPTION 'accounts.became_client_how must be formed_by_us or onboarded (got %)', NEW.became_client_how;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_became_client_how_guard ON public.accounts;
CREATE TRIGGER trg_accounts_became_client_how_guard
  BEFORE INSERT OR UPDATE OF became_client_how ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_accounts_became_client_how();

-- First guess for every ACTIVE, real CLIENT company that has no value yet. Same order as lib/accounts/became-client.ts:
--   1. a signed formation contract (and no onboarding one)  -> formed_by_us
--   2. a signed onboarding contract (and no formation one)  -> onboarded
--   3. otherwise Client Since filled -> onboarded, empty -> formed_by_us   (the rule Antonio gave on 2026-11-14)
-- Left UNCHECKED (became_client_how_checked_at stays NULL): a person confirms each one.
WITH c AS (
  SELECT o.account_id,
         bool_or(o.contract_type = 'formation')  AS has_formation,
         bool_or(o.contract_type = 'onboarding') AS has_onboarding
  FROM public.offers o
  JOIN public.contracts k ON k.offer_token = o.token
  WHERE o.account_id IS NOT NULL AND o.contract_type IN ('formation', 'onboarding')
  GROUP BY o.account_id
)
UPDATE public.accounts a
SET became_client_how = CASE
      WHEN COALESCE(c.has_formation, false) AND NOT COALESCE(c.has_onboarding, false) THEN 'formed_by_us'
      WHEN COALESCE(c.has_onboarding, false) AND NOT COALESCE(c.has_formation, false) THEN 'onboarded'
      WHEN a.client_since IS NOT NULL THEN 'onboarded'
      ELSE 'formed_by_us'
    END
FROM public.accounts x
LEFT JOIN c ON c.account_id = x.id
WHERE x.id = a.id
  AND a.became_client_how IS NULL
  AND a.account_type = 'Client'
  AND a.status = 'Active'
  AND COALESCE(a.is_test, false) = false;
