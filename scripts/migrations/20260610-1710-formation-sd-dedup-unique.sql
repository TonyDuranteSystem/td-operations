-- Kill the duplicate-formation race ONCE AND FOR ALL (Michele Cotti, 2026-06-10).
--
-- Problem: activation creates a contact-scoped "Company Formation" service_delivery
-- with an app-level "does one already exist?" check (ilike notes '%offer_token%')
-- followed by a separate INSERT. The check and the insert are not atomic and there
-- is no DB constraint, so two concurrent/retried activations for the SAME offer both
-- pass the check and both insert -> two Company Formation SDs (Michele got two, 2s
-- apart, 2026-06-10 11:15:28 + 11:15:30).
--
-- Fix: promote the originating offer token from the freetext `notes`
-- ("Auto-created from offer <token>") to a first-class column, then add a PARTIAL
-- UNIQUE INDEX so the database itself forbids a second ACTIVE, contact-scoped
-- formation SD for the same (contact, offer). The losing INSERT then throws a
-- unique violation which activate-service catches and treats as "already exists".
--
-- Why this does NOT block a legitimate second simultaneous new-company formation:
-- the key includes source_offer_token (each new company = its own offer = its own
-- token), and the index is scoped to status='active' + account_id IS NULL +
-- source_offer_token IS NOT NULL, so cancelled / materialized / legacy token-less
-- rows are all excluded.

ALTER TABLE service_deliveries
  ADD COLUMN IF NOT EXISTS source_offer_token text;

COMMENT ON COLUMN service_deliveries.source_offer_token IS
  'Originating offer token for contact-scoped Company Formation SDs. Dedup key for the partial unique index uq_formation_sd_active_per_offer. Set by activate-service at creation; backfilled from notes for historical rows.';

-- Backfill historical formation SDs from their notes.
UPDATE service_deliveries
SET source_offer_token = substring(notes from 'from offer ([A-Za-z0-9_-]+)')
WHERE service_type = 'Company Formation'
  AND source_offer_token IS NULL
  AND notes ~ 'from offer ';

-- The guard. Partial + token-scoped so it only constrains the rows that the
-- activation race can duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_formation_sd_active_per_offer
  ON service_deliveries (contact_id, source_offer_token)
  WHERE service_type = 'Company Formation'
    AND account_id IS NULL
    AND status = 'active'
    AND source_offer_token IS NOT NULL;
