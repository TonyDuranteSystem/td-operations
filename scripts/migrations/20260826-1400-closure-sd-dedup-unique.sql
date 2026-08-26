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

-- REVISED same day (independent post-build review, both Senior Engineer and
-- Bug Hunter, run at Antonio's request): a plain contact_id index is too
-- coarse. A contact-only client can have MORE THAN ONE untracked external LLC
-- (the exact case this branch exists for) — keying on contact_id alone means
-- a second, unrelated LLC's closure would be misread as a resubmission of the
-- first one's record. Formation's own dedup fix (the precedent this file
-- already cites) hit the identical shape and solved it by scoping on
-- (contact_id, source_offer_token) instead of contact_id alone
-- (20260610-1710-formation-sd-dedup-unique.sql) — this does the same thing
-- with a closure-specific token column.
ALTER TABLE service_deliveries ADD COLUMN IF NOT EXISTS source_closure_token text;

-- Backfill: every contact-only Company Closure row that exists today was
-- created by the one known code path (app/api/closure-form-completed/route.ts),
-- which has always written `notes = 'Auto-created from closure form <token>'`.
-- Recovering the token from that text (rather than leaving it NULL) means an
-- existing client's genuine resubmission still matches their own row after
-- this migration, instead of silently minting a second one.
UPDATE service_deliveries
SET source_closure_token = substring(notes from 'Auto-created from closure form (\S+)')
WHERE service_type = 'Company Closure'
  AND account_id IS NULL
  AND contact_id IS NOT NULL
  AND source_closure_token IS NULL
  AND notes ~ 'Auto-created from closure form \S+';

DROP INDEX IF EXISTS uq_closure_sd_active_per_contact;

-- A row whose source_closure_token still ends up NULL (no known creator, or an
-- untraceable notes format) is simply unconstrained by this index — Postgres
-- unique indexes never treat two NULLs as equal — so it can't collide with, or
-- block, any other row. That is an acceptable, narrow gap (nothing today
-- retroactively protected), not a correctness regression: this index's job is
-- to stop FUTURE duplicates, and every future row gets a real token at
-- creation time (see the app/api/closure-form-completed/route.ts change in
-- this same push).
CREATE UNIQUE INDEX IF NOT EXISTS uq_closure_sd_active_per_contact_token
  ON service_deliveries (contact_id, source_closure_token)
  WHERE service_type = 'Company Closure'
    AND status = 'active'
    AND account_id IS NULL
    AND contact_id IS NOT NULL
    AND source_closure_token IS NOT NULL;
