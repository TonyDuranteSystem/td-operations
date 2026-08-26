-- Prevent duplicate "Company Closure" service deliveries at the database level
-- (dev job fbbf4abe). The portal wizard's closure branch is about to start
-- calling createSD() the moment a client submits — an app-level "does one
-- already exist?" check followed by a separate INSERT is the exact
-- check-then-insert race that already duplicated a Company Formation SD in
-- production once before (Michele Cotti, 2026-06-10, see
-- 20260610-1710-formation-sd-dedup-unique.sql). This closes the same class of
-- race for closure, before it ships, not after an incident.
--
-- Closure is a FLEXIBLE_WIZARD_TYPE (lib/portal/wizard-map.ts): a client may be
-- closing a managed company (account_id set) OR an external LLC that was never
-- tracked as a CRM account (account_id NULL, contact_id-only — the real,
-- already-confirmed pattern for at least one live client). Two partial unique
-- indexes cover both shapes; a row with neither id set is not constrained by
-- either (matches the formation precedent's own scoping philosophy).

CREATE UNIQUE INDEX IF NOT EXISTS uq_closure_sd_active_per_account
  ON service_deliveries (account_id)
  WHERE service_type = 'Company Closure'
    AND status = 'active'
    AND account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_closure_sd_active_per_contact
  ON service_deliveries (contact_id)
  WHERE service_type = 'Company Closure'
    AND status = 'active'
    AND account_id IS NULL
    AND contact_id IS NOT NULL;
