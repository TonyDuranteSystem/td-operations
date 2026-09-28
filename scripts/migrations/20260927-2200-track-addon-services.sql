-- Workspace-only plan S1 (dev job 9d34e750, Antonio 2026-09-27: "track them as
-- service sold to work on"). Shipping, Public Notary, Consulting Call and
-- Certificate of Incumbency were sold as invoice lines only — nothing to work
-- on, and sold ALONE they turned into a fake company formation. From now on each
-- is a real service: a pipeline name (so the Create Offer dialog stamps it on the
-- offer line), created AT PAYMENT in every contract, with simple stages staff can
-- move (names are a first proposal — editable in the catalog, no deploy).
-- Placement follows the offer (company page → that company; lead/contact page →
-- the person). Shipping / Notary / Consulting can live on a person
-- (contact_eligible); Incumbency is a company document.
-- Idempotent: re-running changes nothing.

-- 1. Pipeline name + tags on the four catalog services.
UPDATE catalog_entries ce
SET metadata = jsonb_set(COALESCE(ce.metadata, '{}'::jsonb), '{pipeline}', to_jsonb(v.pipeline), true),
    tags = (
      SELECT jsonb_agg(DISTINCT t ORDER BY t)
      FROM jsonb_array_elements_text(COALESCE(ce.tags, '[]'::jsonb) || v.add_tags) AS t
    ),
    updated_at = now()
FROM (VALUES
  ('shipping',                  'Shipping',                  '["sd","start_at_activation","contact_eligible"]'::jsonb),
  ('public_notary',             'Public Notary',             '["sd","start_at_activation","contact_eligible"]'::jsonb),
  ('consulting',                'Consulting Call',           '["sd","start_at_activation","contact_eligible"]'::jsonb),
  ('certificate_of_incumbency', 'Certificate of Incumbency', '["sd","start_at_activation"]'::jsonb)
) AS v(slug, pipeline, add_tags)
WHERE ce.catalog_id = 'services'
  AND ce.slug = v.slug
  AND jsonb_typeof(COALESCE(ce.tags, '[]'::jsonb)) = 'array'
  AND (ce.metadata->>'pipeline' IS DISTINCT FROM v.pipeline OR NOT (COALESCE(ce.tags, '[]'::jsonb) @> v.add_tags));

-- 2. Stages (skip any that already exist).
INSERT INTO pipeline_stages (service_type, stage_order, stage_name, client_description, auto_advance, notify_client_email, requires_approval, service_type_entry_id)
SELECT v.service_type, v.stage_order, v.stage_name, v.client_description, true, false, false, ce.id
FROM (VALUES
  ('Shipping',                  'shipping',                  1, 'Preparing Shipment',  'We are preparing your shipment.'),
  ('Shipping',                  'shipping',                  2, 'Shipped',             'Your shipment is on its way.'),
  ('Shipping',                  'shipping',                  3, 'Delivered',           'Your shipment has been delivered.'),
  ('Public Notary',             'public_notary',             1, 'Documents Received',  'We have received the documents to notarize.'),
  ('Public Notary',             'public_notary',             2, 'Notarized',           'Your documents have been notarized.'),
  ('Public Notary',             'public_notary',             3, 'Returned to Client',  'Your notarized documents have been sent to you.'),
  ('Consulting Call',           'consulting',                1, 'To Schedule',         'We will schedule your call.'),
  ('Consulting Call',           'consulting',                2, 'Scheduled',           'Your call is scheduled.'),
  ('Consulting Call',           'consulting',                3, 'Call Done',           'Your call has taken place.'),
  ('Certificate of Incumbency', 'certificate_of_incumbency', 1, 'Requested',           'We have requested your Certificate of Incumbency.'),
  ('Certificate of Incumbency', 'certificate_of_incumbency', 2, 'Received',            'Your Certificate of Incumbency has been issued.'),
  ('Certificate of Incumbency', 'certificate_of_incumbency', 3, 'Sent to Client',      'Your Certificate of Incumbency has been sent to you.')
) AS v(service_type, slug, stage_order, stage_name, client_description)
JOIN catalog_entries ce ON ce.catalog_id = 'services' AND ce.slug = v.slug
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps WHERE ps.service_type = v.service_type AND ps.stage_order = v.stage_order
);

-- 3. Race backstop for the payment step: one active service of each type per offer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_addon_types_active_per_offer
  ON public.service_deliveries (service_type, source_offer_token)
  WHERE service_type IN ('Shipping', 'Public Notary', 'Consulting Call', 'Certificate of Incumbency')
    AND status = 'active'
    AND source_offer_token IS NOT NULL;

SELECT slug, metadata->>'pipeline' AS pipeline, tags FROM catalog_entries
WHERE catalog_id = 'services' AND slug IN ('shipping', 'public_notary', 'consulting', 'certificate_of_incumbency');
