-- WS-B (dev job c0a61e44): formation state pinned on the offer, threaded to activation.
-- Additive + nullable, no backfill: NULL means "not captured" and every consumer
-- falls back through the resolution chain (wizard → submission → offer → NM default).
-- Validation lives in code ONLY (lib/formation/states.ts — the single source of
-- truth per architect R3-1.2); no DB CHECK on purpose, a CHECK would be a second
-- copy of the state list.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS formation_state text;
ALTER TABLE pending_activations ADD COLUMN IF NOT EXISTS formation_state text;

COMMENT ON COLUMN offers.formation_state IS
  'Formation state code (NM|WY|FL|DE) pinned at offer creation. Display + downstream default; validated in code via lib/formation/states.ts. NULL = not captured (pre-WS-B offers).';
COMMENT ON COLUMN pending_activations.formation_state IS
  'Copied from offers.formation_state by the offer-signed webhook at signing; consumed by the formation flow as the offer-tier default.';
