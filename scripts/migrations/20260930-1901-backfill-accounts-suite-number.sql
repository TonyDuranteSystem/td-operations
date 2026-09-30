-- One-time backfill of accounts.suite_number from each company's lease.
--
-- Picks the company's EARLIEST lease whose tenant is the company itself (the same
-- rule createLease uses to reuse a suite on renewal — a separate personal lease
-- on the same account, e.g. Imperium Commerce, is never picked). Skips:
--   * accounts that already have a suite set,
--   * suites held by more than one company (3D-115, 3D-210) — those need a human
--     to decide who keeps the number; they are listed by the check query below,
--   * anything not shaped like 3D-NNN.
-- Companies with NO lease keep suite_number NULL: nothing is guessed for them.
--
-- Run 20260930-1900-accounts-suite-number.sql first.

UPDATE public.accounts a
SET suite_number = l.suite_number
FROM (
  SELECT DISTINCT ON (ls.account_id) ls.account_id, ls.suite_number
  FROM public.lease_agreements ls
  JOIN public.accounts ac ON ac.id = ls.account_id AND lower(btrim(ls.tenant_company)) = lower(btrim(ac.company_name))
  WHERE ls.suite_number ~ '^3D-[0-9]+$'
  ORDER BY ls.account_id, ls.created_at ASC
) l
WHERE a.id = l.account_id
  AND a.suite_number IS NULL
  AND l.suite_number NOT IN (
    SELECT suite_number
    FROM public.lease_agreements
    WHERE suite_number ~ '^3D-[0-9]+$'
    GROUP BY suite_number
    HAVING count(DISTINCT account_id) > 1
  );

-- Check 1 (read-only): AFTER running, companies that HAVE a lease but still have no
-- suite (renamed company, personal-only lease, or a shared suite) — review by hand:
-- SELECT a.company_name, string_agg(DISTINCT l.suite_number || ' (' || l.tenant_company || ')', ', ')
-- FROM public.accounts a JOIN public.lease_agreements l ON l.account_id = a.id
-- WHERE a.suite_number IS NULL AND a.status = 'Active' GROUP BY 1 ORDER BY 1;
--
-- Check 2 (read-only): companies whose lease suite could NOT be filled in
-- automatically because two companies share it.
-- SELECT ls.suite_number, ls.tenant_company FROM public.lease_agreements ls
-- WHERE ls.suite_number IN (SELECT suite_number FROM public.lease_agreements GROUP BY 1 HAVING count(DISTINCT account_id) > 1)
-- ORDER BY 1, 2;
