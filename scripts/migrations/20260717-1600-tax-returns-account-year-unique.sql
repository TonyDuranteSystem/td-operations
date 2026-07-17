-- Renewal-chain fix (dev job e6136a5e / parent 8cc8e1c8): the payment chain
-- now ENSURES a tax_returns record exists per (account, tax year). Race
-- safety lives HERE (R098 pattern) — a partial unique index — not in a code
-- retry loop. Verified 2026-07-17: zero duplicate (account_id, tax_year)
-- pairs on prod. The dedupe below is defensive anyway: if a twin appeared
-- between verification and DDL, keep the OLDEST row (stable ids are already
-- referenced by submissions/logs) and delete newer twins, so the index can
-- always be created.
--
-- PROD ORDER: this DDL goes in BEFORE the code ship (opposite of the
-- 20260716 default-drop, deliberately): old code never successfully inserts
-- from the installment chain (its insert has been failing NOT NULL on
-- company_name/deadline since inception), so the index breaks nothing —
-- while shipping code first would leave a race window in which twins could
-- be created and then BLOCK this index.

DELETE FROM tax_returns t
USING tax_returns twin
WHERE t.account_id = twin.account_id
  AND t.tax_year = twin.tax_year
  AND t.account_id IS NOT NULL
  AND t.created_at > twin.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_returns_account_year
  ON tax_returns (account_id, tax_year)
  WHERE account_id IS NOT NULL;
