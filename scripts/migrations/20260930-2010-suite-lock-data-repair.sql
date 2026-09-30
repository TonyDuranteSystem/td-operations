-- Suite lock — ONE-TIME DATA REPAIR (Antonio's decisions, 2026-09-30).
--
-- PRODUCTION ORDER:  1) 20260930-2000-suite-lock.sql   2) THIS file, straight away   3) deploy the code
--                    4) 20260930-2020-suite-lock-after-deploy.sql
-- (Running this right after step 1 keeps the OLD code working — it reads the company's suite first — and
--  nothing in here needs the new code. The new code also adopts a company's own lease suite, so a deploy
--  before this file is safe too; but do not leave the gap open.)
--
-- Runs as ONE transaction: if any step fails, nothing is changed. Every step is also guarded by id AND
-- name/status, so re-running it after a success changes nothing. It sends nothing to any client.
--
--   Vanallen keeps 3D-115, Kasabi keeps 3D-210. SEuforia and AWY lose their shared suite (old signed
--   lease deleted + its PDF hidden from the portal) and each gets a NEW suite; their new leases are
--   created afterwards from the CRM (draft → Antonio reviews → sends).
--   Imperium's signed PERSONAL lease 3D-112 is deleted (the company keeps 3D-111; 3D-112 stays a gap — it was never on the company, so it is not put back in the pool).
--     (Its three "Office Lease … Bence Koncz" PDFs are already hidden from the portal — checked 2026-09-30.)
--   Italiza and New E-commerce Solutions get NO suite (their two draft leases are removed).
--   Growthlane / Ad Astra: their draft leases carry an old / misspelled tenant name — the company keeps the
--   suite on its draft and the tenant name is corrected to the company's current name.
--   Every other ACTIVE client company gets the suite it already holds on its own lease loaded onto the company
--   (Degasper — suspended — and SupraEmerge — closed — are NOT loaded: their suites stay on their lease records).
--   Every remaining ACTIVE client company (account type Client, no lease yet, ~108) is issued a suite now, oldest
--   company first; one-time customers (e.g. Cleo Home LLC) and the two test accounts ("Test", "QA E2E Test LLC") are
--   skipped; no address is written for them.
--   Uxio Test (is_test) is left alone.
--
-- Deletions go through admin_delete_lease, which keeps a full copy of the lease in suite_audit_log.
-- TO RESTORE a deleted lease (there is no button for it): in ONE transaction run
--   SELECT set_config('app.suite_admin','on',true);
--   INSERT INTO lease_agreements SELECT * FROM jsonb_populate_record(NULL::lease_agreements,
--     (SELECT detail FROM suite_audit_log WHERE action='lease_deleted' AND old_suite='<suite>' ORDER BY id DESC LIMIT 1));
--   and un-hide its document (documents.portal_visible = true). The company must still hold that suite.
--
-- BEFORE RUNNING, save a copy of: lease_agreements (143 rows), the two documents rows below, the addresses
-- row 4706c595…, and  SELECT id, suite_number FROM accounts.

BEGIN;

-- ─── 0. PRE-FLIGHT: refuse to run if the data is not what this script was written for ────────
DO $$
DECLARE v_bad text;
BEGIN
  -- every hard-coded lease must still be exactly what we expect (or already repaired = gone)
  SELECT string_agg(x.id::text, ', ') INTO v_bad FROM (
    SELECT l.id FROM lease_agreements l WHERE l.id IN (
        'ff56e27b-e781-454b-936c-52d45b5cd7fc','210706a7-42a6-4713-97e0-b1e604982dfd','e0097080-cce8-4395-903f-bf92251001d4',
        'b926b9f3-c36e-4e1a-bba6-92addd7711ea','af466cb2-8c84-40aa-9335-696a694936dd',
        '5365e8a8-27c3-4d55-adad-34ae3372ba21','aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf')
      AND (l.id, l.tenant_company, l.suite_number) NOT IN (
        ('ff56e27b-e781-454b-936c-52d45b5cd7fc'::uuid,'Bence Koncz','3D-112'),
        ('210706a7-42a6-4713-97e0-b1e604982dfd','SEuforia Consulting & Services LLC','3D-115'),
        ('e0097080-cce8-4395-903f-bf92251001d4','AWY Company LLC','3D-210'),
        ('b926b9f3-c36e-4e1a-bba6-92addd7711ea','Italiza LLC','3D-235'),
        ('af466cb2-8c84-40aa-9335-696a694936dd','New E-commerce Solutions LLC','3D-290'),
        ('5365e8a8-27c3-4d55-adad-34ae3372ba21','DF Commerce LLC','3D-250'),
        ('5365e8a8-27c3-4d55-adad-34ae3372ba21','Growthlane Marketing LLC','3D-250'),
        ('aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf','Ad Astra Strategic Advisor LLC','3D-204'),
        ('aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf','Ad Astra Strategic Advisors LLC','3D-204'))
  ) x;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'PRE-FLIGHT FAILED: lease(s) % are not what this script expects — stop and re-check', v_bad; END IF;

  -- the four accounts must be the companies we think they are
  IF (SELECT count(*) FROM accounts WHERE (id, company_name) IN (
        ('63392d94-c327-443f-b5b1-bee7a5e923d5'::uuid,'Growthlane Marketing LLC'),
        ('3ac972fa-7c36-4925-bcd7-cf6260954714','Ad Astra Strategic Advisors LLC'),
        ('2809f939-5462-4d18-8f40-15a71283fa88','SEuforia Consulting & Services LLC'),
        ('39876d6f-82b2-44d5-aede-d9057d0c3a7e','AWY Company LLC'))) <> 4 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAILED: one of the four special accounts is not the company this script expects';
  END IF;
END $$;

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
  AND account_id IN ('2809f939-5462-4d18-8f40-15a71283fa88', '39876d6f-82b2-44d5-aede-d9057d0c3a7e')
  AND portal_visible = true;

-- 3b. delete EVERY lease of these two companies that sits on a shared suite (logged) — the signed ones and
--     any other year — so the load step below cannot hit a shared suite
SELECT admin_delete_lease(l.id, 'Shared suite — the other company keeps it; this company is issued a new suite and lease (Antonio 2026-09-30)', 'antonio:repair')
FROM lease_agreements l
WHERE l.account_id IN ('2809f939-5462-4d18-8f40-15a71283fa88', '39876d6f-82b2-44d5-aede-d9057d0c3a7e')
  AND l.suite_number IN ('3D-115', '3D-210');

-- ─── 4. Growthlane + Ad Astra: keep the suite on their draft, correct the tenant name ───────
SELECT assign_specific_company_suite('63392d94-c327-443f-b5b1-bee7a5e923d5'::uuid, '3D-250', 'antonio:repair')
WHERE EXISTS (SELECT 1 FROM lease_agreements WHERE id = '5365e8a8-27c3-4d55-adad-34ae3372ba21' AND account_id = '63392d94-c327-443f-b5b1-bee7a5e923d5' AND suite_number = '3D-250')
  AND (SELECT suite_number FROM accounts WHERE id = '63392d94-c327-443f-b5b1-bee7a5e923d5') IS NULL;
SELECT assign_specific_company_suite('3ac972fa-7c36-4925-bcd7-cf6260954714'::uuid, '3D-204', 'antonio:repair')
WHERE EXISTS (SELECT 1 FROM lease_agreements WHERE id = 'aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf' AND account_id = '3ac972fa-7c36-4925-bcd7-cf6260954714' AND suite_number = '3D-204')
  AND (SELECT suite_number FROM accounts WHERE id = '3ac972fa-7c36-4925-bcd7-cf6260954714') IS NULL;

UPDATE lease_agreements SET tenant_company = 'Growthlane Marketing LLC'
WHERE id = '5365e8a8-27c3-4d55-adad-34ae3372ba21' AND status = 'draft' AND tenant_company = 'DF Commerce LLC';
UPDATE lease_agreements SET tenant_company = 'Ad Astra Strategic Advisors LLC'
WHERE id = 'aaa81f7d-0a11-42be-8d9a-8dd1c7f471cf' AND status = 'draft' AND tenant_company = 'Ad Astra Strategic Advisor LLC';

-- ─── 5. PRE-FLIGHT for the load: no suite may still be held by two companies ─────────────────
DO $$
DECLARE v_shared text;
BEGIN
  SELECT string_agg(suite_number, ', ') INTO v_shared FROM (
    SELECT suite_number FROM lease_agreements WHERE suite_number IS NOT NULL
    GROUP BY suite_number HAVING count(DISTINCT account_id) > 1) s;
  IF v_shared IS NOT NULL THEN RAISE EXCEPTION 'Suite(s) % are still on leases of more than one company — resolve before loading', v_shared; END IF;
END $$;

-- ─── 5a. Load: every ACTIVE client company gets the suite it already holds on its OWN lease ──
-- (earliest lease whose tenant is the company itself. One-time customers, closed / suspended / inactive
--  companies and test accounts are NOT loaded — their suite stays on the lease record and is never reissued;
--  if one is ever reactivated or needs a lease, "Issue suite" adopts the suite it already holds.)
UPDATE accounts a
SET suite_number = l.suite_number
FROM (
  SELECT DISTINCT ON (ls.account_id) ls.account_id, ls.suite_number
  FROM lease_agreements ls
  JOIN accounts ac ON ac.id = ls.account_id AND lower(btrim(ls.tenant_company)) = lower(btrim(ac.company_name))
  WHERE ls.suite_number ~ '^3D-[0-9]{3,4}$'
    AND COALESCE(ac.is_test, false) = false
    AND ac.account_type = 'Client'
    AND ac.status = 'Active'
  ORDER BY ls.account_id, ls.created_at ASC
) l
WHERE a.id = l.account_id AND a.suite_number IS NULL;

-- 5b. the address the Operating Agreement prints follows the suite (only where empty or already "10225 Ulmerton Rd…";
--     a hand-typed address is never touched)
UPDATE accounts
SET physical_address = '10225 Ulmerton Rd, Suite ' || suite_number || ', Largo, FL 33771'
WHERE suite_number IS NOT NULL
  AND (physical_address IS NULL OR btrim(physical_address) = '' OR physical_address ILIKE '10225 Ulmerton Rd%')
  AND physical_address IS DISTINCT FROM '10225 Ulmerton Rd, Suite ' || suite_number || ', Largo, FL 33771';

-- ─── 6. SEuforia + AWY: issue each a NEW suite (next free number) ────────────────────────────
SELECT allocate_company_suite(a.id, NULL, 'antonio:repair') AS new_suite, a.company_name
FROM accounts a
WHERE (a.id, a.company_name) IN (('2809f939-5462-4d18-8f40-15a71283fa88'::uuid, 'SEuforia Consulting & Services LLC'),
                                 ('39876d6f-82b2-44d5-aede-d9057d0c3a7e', 'AWY Company LLC'))
  AND a.suite_number IS NULL;

UPDATE accounts
SET physical_address = '10225 Ulmerton Rd, Suite ' || suite_number || ', Largo, FL 33771'
WHERE id IN ('2809f939-5462-4d18-8f40-15a71283fa88', '39876d6f-82b2-44d5-aede-d9057d0c3a7e')
  AND suite_number IS NOT NULL
  AND (physical_address IS NULL OR btrim(physical_address) = '' OR physical_address ILIKE '10225 Ulmerton Rd%');

-- ─── 6b. Every other ACTIVE client company gets a suite now (Antonio 2026-09-30: "now") ─────────
-- These companies have no lease yet. Issued in order of when the company was created (oldest first), by the
-- same allocator as everything else. Test accounts are skipped. Only the suite is issued — NO address is
-- written (a company with no EIN and no mailing address would otherwise see its EIN application switch from
-- the Seminole fallback to Largo). Their leases (January) and the Operating Agreement pick the suite up later.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT a.id FROM accounts a
    WHERE a.status = 'Active' AND a.account_type = 'Client' AND COALESCE(a.is_test, false) = false
      AND a.suite_number IS NULL
      AND a.company_name !~* '(^test$|qa e2e|^zz |sandbox|demo)'
    ORDER BY a.created_at ASC, a.id ASC
  LOOP
    PERFORM allocate_company_suite(r.id, NULL, 'antonio:repair-backfill');
  END LOOP;
END $$;

COMMIT;

-- ─── VERIFY (read-only) ─────────────────────────────────────────────────────────────────────
-- A) how many companies now hold a suite, and that none is shared (expect 245 and 0):
-- SELECT count(*) FILTER (WHERE suite_number IS NOT NULL) AS with_suite,
--        (SELECT count(*) FROM (SELECT suite_number FROM accounts WHERE suite_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1) s) AS shared
-- FROM accounts;
-- B) any lease whose suite is not its company's suite (expect only Uxio Test, which is left alone):
-- SELECT a.company_name, l.suite_number AS lease_suite, a.suite_number AS company_suite, l.status
-- FROM lease_agreements l JOIN accounts a ON a.id = l.account_id
-- WHERE l.suite_number IS DISTINCT FROM a.suite_number ORDER BY 1;
-- C) the new suites and the repair log:
-- SELECT created_at, action, account_id, old_suite, new_suite, reason FROM suite_audit_log ORDER BY id;
-- D) reservations whose delivery is cancelled / missing (must be empty; free any with release_suite_reservation):
-- SELECT r.* FROM suite_reservations r LEFT JOIN service_deliveries sd ON sd.id = r.delivery_id WHERE sd.id IS NULL OR sd.status = 'cancelled';
