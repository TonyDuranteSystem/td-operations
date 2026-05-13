-- Tax Return workflow redesign — Wizard Available + One-Time pipeline.
--
-- Verified sandbox state before applying (ref: xjcxlmlpeywtwkhstjlw):
--   - tax_return_status enum already has 'Wizard Available' (idempotent ADD)
--   - pipeline_stages for 'Tax Return' currently has stages 1-9; stage 4 is
--     already named 'Wizard Available' from a prior partial run. Only stage 4
--     has a client_description; the rest are NULL.
--   - pipeline_stages for 'Tax Return One-Time' currently has 7 rows from a
--     prior partial run, but with the WRONG structure. We replace them with
--     the canonical 8-stage One-Time pipeline. Safe to delete: 0 SDs exist
--     with service_type='Tax Return One-Time'.
--   - catalog_entries has no 'tax_return_one_time' slug yet.
--
-- This migration is fully idempotent.
--
-- Annual Tax Return pipeline (existing, post 1st-installment activation):
--   1. 1st Installment Paid
--   2. Extension Filed
--   3. Awaiting 2nd Payment
--   4. Wizard Available     ← entry to data-collection (was '2nd Installment Paid')
--   5. Data Received
--   6. Preparation
--   7. TR Completed
--   8. TR Filed
--   9. Terminated - Non Payment
--
-- One-Time Tax Return pipeline (new, standalone clients):
--   0. Payment Pending
--   1. Payment Received
--   2. Wizard Available
--   3. Data Received
--   4. Preparation
--   5. TR Completed
--   6. TR Filed
--   7. Terminated
--
-- Apply to SANDBOX first:
--   node scripts/apply-migration.js scripts/migrations/20260513-tax-return-wizard-available.sql

-- ─── 1. Ensure enum has 'Wizard Available' ────────────────────────────────
ALTER TYPE tax_return_status ADD VALUE IF NOT EXISTS 'Wizard Available';

-- ─── 2. Annual Tax Return: ensure stage 4 is 'Wizard Available' with description
-- Idempotent: handles either pre-rename ('2nd Installment Paid') or post-rename state.
UPDATE pipeline_stages
SET stage_name = 'Wizard Available',
    client_description = 'Your tax data collection form is ready. Please fill it in the portal.'
WHERE service_type = 'Tax Return'
  AND stage_order = 4;

-- ─── 3. Set client_descriptions for ALL Annual Tax Return stages ─────────
UPDATE pipeline_stages SET client_description =
  'Your first installment has been received. We''re getting started on your services.'
  WHERE service_type = 'Tax Return' AND stage_name = '1st Installment Paid';

UPDATE pipeline_stages SET client_description =
  'Tax extension has been filed. You''ll have additional time to provide your tax documents.'
  WHERE service_type = 'Tax Return' AND stage_name = 'Extension Filed';

UPDATE pipeline_stages SET client_description =
  'Awaiting your second installment payment to proceed with tax filing.'
  WHERE service_type = 'Tax Return' AND stage_name = 'Awaiting 2nd Payment';

UPDATE pipeline_stages SET client_description =
  'We have received your tax data and will prepare your return shortly.'
  WHERE service_type = 'Tax Return' AND stage_name = 'Data Received';

UPDATE pipeline_stages SET client_description =
  'Your tax return is being prepared by our team.'
  WHERE service_type = 'Tax Return' AND stage_name = 'Preparation';

UPDATE pipeline_stages SET client_description =
  'Your tax return is complete and awaiting your signature.'
  WHERE service_type = 'Tax Return' AND stage_name = 'TR Completed';

UPDATE pipeline_stages SET client_description =
  'Your tax return has been filed successfully.'
  WHERE service_type = 'Tax Return' AND stage_name = 'TR Filed';

UPDATE pipeline_stages SET client_description =
  'Service terminated due to non-payment.'
  WHERE service_type = 'Tax Return' AND stage_name = 'Terminated - Non Payment';

-- ─── 4. Tax Return One-Time catalog entry ────────────────────────────────
-- Idempotent: ON CONFLICT skips if slug already present.
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'services',
  'tax_return_one_time',
  'Tax Return One-Time',
  '{"it": "Dichiarazione Fiscale (Una Tantum)"}'::jsonb,
  'One-time standalone tax return preparation and filing for clients not on the annual management bundle.',
  'active',
  '["service", "sd", "sellable"]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- ─── 5. Tax Return One-Time pipeline_stages — replace with canonical 8 ────
-- Safe DELETE: verified 0 service_deliveries rows with service_type='Tax Return One-Time'.
-- The prior partial run created 7 rows with the wrong stage_order numbering;
-- we replace them with the correct 8-stage pipeline (stage_order 0..7).
DELETE FROM pipeline_stages WHERE service_type = 'Tax Return One-Time';

INSERT INTO pipeline_stages (
  service_type,
  stage_order,
  stage_name,
  client_description,
  auto_advance,
  notify_client_email,
  requires_approval,
  service_type_entry_id
)
SELECT
  'Tax Return One-Time',
  v.stage_order,
  v.stage_name,
  v.client_description,
  false,           -- auto_advance: stay manual for One-Time tax flow
  false,           -- notify_client_email
  false,           -- requires_approval
  ce.id
FROM (
  VALUES
    (0, 'Payment Pending',  'Payment pending. Once we receive your payment we''ll begin preparing your tax return.'),
    (1, 'Payment Received', 'Payment received. We''re getting started on your tax return.'),
    (2, 'Wizard Available', 'Your tax data collection form is ready. Please fill it in the portal.'),
    (3, 'Data Received',    'We have received your tax data and will prepare your return shortly.'),
    (4, 'Preparation',      'Your tax return is being prepared by our team.'),
    (5, 'TR Completed',     'Your tax return is complete and awaiting your signature.'),
    (6, 'TR Filed',         'Your tax return has been filed successfully.'),
    (7, 'Terminated',       'Service terminated.')
) AS v(stage_order, stage_name, client_description)
JOIN catalog_entries ce
  ON ce.catalog_id = 'services' AND ce.slug = 'tax_return_one_time';

-- ─── 6. Backfill service_type_entry_id for Annual Tax Return stages ──────
-- If any stages are missing the entry id pointer, fix them. Idempotent.
UPDATE pipeline_stages ps
SET service_type_entry_id = ce.id
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND ce.slug = 'tax_return'
  AND ps.service_type = 'Tax Return'
  AND ps.service_type_entry_id IS NULL;
