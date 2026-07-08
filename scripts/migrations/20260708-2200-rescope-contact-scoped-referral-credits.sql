-- Re-scope person-scoped referral credit notes to the person's company.
--
-- Why: the manual Add-referral flow used to credit exactly the picked actor;
-- picking a person created a credit note with account_id NULL. Such a credit is
-- invisible in Finance → invoices by client (account-keyed) and can never be
-- applied to the company's invoices (credit application is account-only,
-- lib/operations/credit-netting.ts). Ships together with the UI fix that
-- defaults a person to their company (dev_task 2974804d).
--
-- Rule: only people with exactly ONE linked company are re-scoped (no guessing
-- for multi-company people). Population at authoring time: 1 row in prod —
-- CN-000011, Giuseppe Cirino → N1Marketing LLC ($200, referral 4fec4223).
-- Touches: payments (the credit note), client_expenses (its portal mirror),
-- referrals (account attribution on credited contact-keyed rows).
-- Idempotent: every UPDATE filters on account_id IS NULL.

-- 1. The credit notes themselves.
WITH single_acct AS (
  SELECT contact_id, min(account_id::text)::uuid AS account_id
  FROM account_contacts
  GROUP BY contact_id
  HAVING count(DISTINCT account_id) = 1
)
UPDATE payments p
SET account_id = sa.account_id
FROM single_acct sa
WHERE p.invoice_status = 'Credit'
  AND p.account_id IS NULL
  AND p.contact_id = sa.contact_id;

-- 2. Their client_expenses mirrors (portal view reads these).
WITH single_acct AS (
  SELECT contact_id, min(account_id::text)::uuid AS account_id
  FROM account_contacts
  GROUP BY contact_id
  HAVING count(DISTINCT account_id) = 1
)
UPDATE client_expenses ce
SET account_id = sa.account_id
FROM single_acct sa
WHERE ce.account_id IS NULL
  AND ce.contact_id = sa.contact_id
  AND ce.td_payment_id IN (
    SELECT id FROM payments WHERE invoice_status = 'Credit'
  );

-- 3. Account attribution on the credited referral rows (contact id is kept —
--    both ids now coexist, which also lets the manual-add dedup match either).
WITH single_acct AS (
  SELECT contact_id, min(account_id::text)::uuid AS account_id
  FROM account_contacts
  GROUP BY contact_id
  HAVING count(DISTINCT account_id) = 1
)
UPDATE referrals r
SET referrer_account_id = sa.account_id
FROM single_acct sa
WHERE r.referrer_account_id IS NULL
  AND r.referrer_contact_id = sa.contact_id
  AND r.status = 'credited';
