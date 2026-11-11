-- UNDO for 20261111-1500-closure-multi-unit.sql (dev job 9829a468).
-- Safe only while NO job carries offer_unit >= 2 (otherwise restoring the old per-offer lock would fail, and
-- dropping the column would lose which unit a job is). Check first:
--   SELECT id, source_offer_token, offer_unit FROM service_deliveries WHERE offer_unit IS NOT NULL;
-- If rows are returned, cancel or re-point those jobs before running this.

UPDATE catalog_entries
   SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"supports_quantity": false}'::jsonb,
       tags = COALESCE(tags, '[]'::jsonb) - 'multi_unit',
       updated_at = now()
 WHERE catalog_id = 'services'
   AND slug = 'closure';

DROP INDEX IF EXISTS uq_closure_sd_active_per_offer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_closure_sd_active_per_offer
  ON service_deliveries (contact_id, source_offer_token)
  WHERE service_type = 'Company Closure'
    AND status = 'active'
    AND source_offer_token IS NOT NULL;

ALTER TABLE service_deliveries DROP COLUMN IF EXISTS offer_unit;
