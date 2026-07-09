-- One-time backfill of account_ref for statements already ingested before the
-- bank-account-identity feature (sysdoc pnl-bank-account-identity-plan, dev_task 339612ec).
--
-- History rows carry no client-provided account number, so the identity is the
-- CANONICAL bank name (buildAccountRef with no number → canonical alone). This
-- HEALS the name-drift split ("Chase" / "chase" / "JPMorgan Chase Bank, N.A." →
-- one "Chase" account) without inventing account numbers. Every other name maps
-- to itself (it is already canonical or genuinely unknown → left as-is).
--
-- The Chase alias group below is a faithful materialization of the resolver's
-- verified output (lib/tax/bank-identity.ts::canonicalBankName). Any name NOT in
-- an alias group keeps its own name as the identity (step 2).
--
-- Idempotent: only fills account_ref IS NULL. Re-runnable.

-- 1a. Chase family → "Chase" (bank_transactions)
UPDATE bank_transactions
   SET account_ref = 'Chase'
 WHERE account_ref IS NULL
   AND btrim(lower(regexp_replace(bank_name, '[^a-zA-Z0-9]+', ' ', 'g'))) IN
       ('chase','chase bank','chase bank na','chase bank n a','jpmorgan','jp morgan',
        'jpmorgan chase','jp morgan chase','jpmorgan chase bank','jpmorgan chase bank na','jpmorgan chase bank n a');

-- 1b. Chase family → "Chase" (pnl_workspace_transactions)
UPDATE pnl_workspace_transactions
   SET account_ref = 'Chase'
 WHERE account_ref IS NULL
   AND btrim(lower(regexp_replace(bank_name, '[^a-zA-Z0-9]+', ' ', 'g'))) IN
       ('chase','chase bank','chase bank na','chase bank n a','jpmorgan','jp morgan',
        'jpmorgan chase','jp morgan chase','jpmorgan chase bank','jpmorgan chase bank na','jpmorgan chase bank n a');

-- 2. Everything else → its own (already-canonical / unknown-but-stable) name.
UPDATE bank_transactions          SET account_ref = btrim(bank_name) WHERE account_ref IS NULL AND bank_name IS NOT NULL;
UPDATE pnl_workspace_transactions SET account_ref = btrim(bank_name) WHERE account_ref IS NULL AND bank_name IS NOT NULL;
