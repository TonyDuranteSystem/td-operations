-- Suite lock — ONE-TIME DATA REPAIR (Antonio's decisions, 2026-09-30).
-- PRODUCTION ORDER: 1) 20260930-2000-suite-lock.sql  2) deploy the code  3) THIS file.
-- Every step is guarded, so re-running it does nothing twice. Nothing here sends anything to a client.
--
--   Vanallen keeps 3D-115, Kasabi keeps 3D-210. SEuforia and AWY lose their shared suite (old signed
--   lease deleted + its PDF hidden from the portal) and each gets a NEW suite; their new leases are
--   created afterwards from the CRM (draft → Antonio reviews → sends).
--   Imperium's signed PERSONAL lease 3D-112 is deleted (the company keeps 3D-111; 3D-112 is never reused).
--   Italiza and New E-commerce Solutions get NO suite (their two draft leases are removed).
--   Growthlane / Ad Astra: their draft leases carry an old / misspelled tenant name — the company keeps the
--   suite on its draft and the tenant name is corrected to the company's current name.
--   Every other company gets the suite it already holds on its own lease loaded onto the company.
--   The shared Principal Office row that printed one company's "Suite 3D-205" becomes the plain office "3D".
--   Uxio Test (is_test) is left alone.
--
-- Deletions go through admin_delete_lease (keeps a full copy of the lease in suite_audit_log).

-- ─── 1. Imperium: delete the personal lease (signed, tenant "Bence Koncz") ───────────────────
SELECT admin_delete_lease(l.id, 'Personal lease — a suite belongs to the company only (Antonio 2026-09-30)', 'antonio:repair')
FROM lease_agreements l
WHERE l.id = 'ff56e27b-e781-454b-936c-52d45b5cd7fc'
  AND l.tenant_company = 'Bence Koncz' AND l.suite_number = '3D-112';

-- ─── 2. Italiza + New E-commerce Solutions: no suite — remove their draft leases ─────────────
SELECT admin_delete_lease(l.id, 'Account is not a client (one-time) — no suite (Antonio 2026-09-30)', 'antonio:repair')
FROM lease_agreements l
WHERE l.id IN ('b926b9f3-c36e-4e1a-bba6-92addd7711ea', 'af466cb2-8c84-40aa-9335-696a694936dd')
  AND l.status = 'draft';

-- ─── 3. Shared suites: SEuforia (3D-115) and AWY (3D-210) give theirs up ────────────────────
-- 3a. hide the two old signed lease PDFs from the client's portal (the files stay in storage)
UPDATE documents SET portal_visible = false
WHERE id IN ('b860f703-f51b-46d1-bc6c-28c106a55fe5', '0ff122bb-baf8-4a12-aafa-c637dcc94440')
  AND portal_visible = true;

-- 3b. delete the two old signed leases (logged)
SELECT admin_delete_lease(l.id, 'Shared suite — the other company keeps it; this company is issued a new suite and lease (Antonio 2026-09-30)', 'antonio:repair')
FROM lease_agreements l
WHERE l.id IN ('210706a7-42a6-4713-97e0-b1e604982dfd', 'e0097080-cce8-4395-903f-bf92251001d4')
  AND (l.tenant_company, l.suite_number) IN (('SEuforia Consulting & Services LLC', '3D-115'), ('AWY Company LLC', '3D-210'));

-- ─── 4. Growthlane + Ad Astra: keep the suite on their draft, correct the tenant name ───────
SELECT assign_specific_company_suite('63392d94-c327-443f-b5b1-bee7a5e923d5'::uuid, '3D-250', 'antonio:repair')
WHERE EXISTS (SELECT 1 FROM lease_agreements WHERE id = '5365e8a8-27c3-4d55-adad-34ae3372ba21' AND suite_number = '3D-250');
SELECT assign_specific_company_suite('3ac972fa-7c36-4925-bcd7-cf6260954714'::uuid, '3D-204', 'antonio:repair')
WHERE EXISTS (SELECT 1 FROM lease_agreements WHERE id = 'aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf' AND suite_number = '3D-204');

UPDATE lease_agreements SET tenant_company = 'Growthlane Marketing LLC'
WHERE id = '5365e8a8-27c3-4d55-adad-34ae3372ba21' AND status = 'draft' AND tenant_company = 'DF Commerce LLC';
UPDATE lease_agreements SET tenant_company = 'Ad Astra Strategic Advisors LLC'
WHERE id = 'aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf' AND status = 'draft' AND tenant_company = 'Ad Astra Strategic Advisor LLC';

-- ─── 5. Load: every client company gets the suite it already holds on its OWN lease ───────────
-- (earliest lease whose tenant is the company itself; test accounts and non-clients are skipped.)
UPDATE accounts a
SET suite_number = l.suite_number
FROM (
  SELECT DISTINCT ON (ls.account_id) ls.account_id, ls.suite_number
  FROM lease_agreements ls
  JOIN accounts ac ON ac.id = ls.account_id AND lower(btrim(ls.tenant_company)) = lower(btrim(ac.company_name))
  WHERE ls.suite_number ~ '^3D-[0-9]{3,4}$'
    AND COALESCE(ac.is_test, false) = false
    AND ac.account_type = 'Client'
  ORDER BY ls.account_id, ls.created_at ASC
) l
WHERE a.id = l.account_id AND a.suite_number IS NULL;

-- ─── 6. SEuforia + AWY: issue each a NEW suite (next free number) ────────────────────────────
SELECT allocate_company_suite(a.id, NULL, 'antonio:repair') AS new_suite, a.company_name
FROM accounts a
WHERE a.id IN ('2809f939-5462-4d18-8f40-15a71283fa88', '39876d6f-82b2-44d5-aede-d9057d0c3a7e')
  AND a.suite_number IS NULL;

-- ─── 7. The shared Principal Office row printed ONE company's suite ("Suite 3D-205") for ~186 companies ─
-- It is our Largo office, shared by everyone: the address is "10225 Ulmerton Rd, 3D" and each company's
-- own suite now comes from the company (the portal, invoices, EIN application etc. overlay it).
UPDATE addresses SET address_line2 = '3D', updated_at = now()
WHERE id = '4706c595-f96e-4031-b44e-b83d0fb80251'
  AND is_td_provided = true
  AND address_line2 = 'Suite 3D-205';

-- ─── VERIFY (read-only) ─────────────────────────────────────────────────────────────────────
-- A) how many companies now hold a suite, and that none is shared (expect 0 shared):
-- SELECT count(*) FILTER (WHERE suite_number IS NOT NULL) AS with_suite,
--        (SELECT count(*) FROM (SELECT suite_number FROM accounts WHERE suite_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1) s) AS shared
-- FROM accounts;
-- B) any lease whose suite is not its company's suite (expect only legacy rows of companies with no suite):
-- SELECT a.company_name, l.suite_number AS lease_suite, a.suite_number AS company_suite, l.status
-- FROM lease_agreements l JOIN accounts a ON a.id = l.account_id
-- WHERE l.suite_number IS DISTINCT FROM a.suite_number ORDER BY 1;
-- C) the new suites and the repair log:
-- SELECT created_at, action, account_id, old_suite, new_suite, reason FROM suite_audit_log ORDER BY id;
