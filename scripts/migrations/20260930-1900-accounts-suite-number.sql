-- Suite assigned to a company — CRM Company Info → "Suite Assigned".
--
-- Until now a company's TD office suite (e.g. 3D-318) lived ONLY on its lease
-- (lease_agreements.suite_number), copied as free text into accounts.physical_address.
-- That meant no suite could be assigned before a lease existed, and nothing in
-- the CRM showed which suite belongs to which company. This column is the
-- company-level home for it: staff edit it in Company Info; createLease reuses it
-- (explicit override > this column > the company's earliest same-tenant lease >
-- next free number); nextSuiteNumber counts it so an assigned suite is never
-- handed to anyone else.
--
-- Deliberately NOT unique: two suites are already held by two companies each
-- (3D-115, 3D-210). The CRM save shows a warning on overlap instead of failing.
-- Tighten to a unique index once those are cleaned up.
--
-- Safe to run ahead of the code: nothing reads the column until the release.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS suite_number text;

COMMENT ON COLUMN public.accounts.suite_number IS
  'TD office suite assigned to this company, canonical form 3D-NNN. Edited in CRM Company Info (Suite Assigned). createLease reuses it; nextSuiteNumber never re-issues it. Not unique yet (3D-115 and 3D-210 are each held by two companies).';

CREATE INDEX IF NOT EXISTS idx_accounts_suite_number
  ON public.accounts (suite_number)
  WHERE suite_number IS NOT NULL;
