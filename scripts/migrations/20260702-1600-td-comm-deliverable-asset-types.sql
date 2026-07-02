-- TD Communication — Phase 12 (Cris's Design Tools): allow tool-generated
-- deliverable types.
--
-- The design tools (mockup previewer + brand asset kit) can SAVE their output
-- into the project's Deliverables. Those outputs are a distinct class from the
-- creative deliverables Cris uploads by hand, so they carry their own types:
--   - 'mockup'    — a schematic brand mockup PNG (logo on card/letterhead/etc.)
--   - 'asset_kit' — a zip of social-sized logos, favicons and background variants
--
-- Additive: extends the existing type CHECK. No existing rows/behaviour change.
-- The inline CHECK from 20260628-1600 is auto-named td_comm_deliverables_type_check;
-- we drop-if-exists and re-add with the two extra values (idempotent).

ALTER TABLE public.td_comm_deliverables
  DROP CONSTRAINT IF EXISTS td_comm_deliverables_type_check;

ALTER TABLE public.td_comm_deliverables
  ADD CONSTRAINT td_comm_deliverables_type_check CHECK (type IN (
    'logo_draft',
    'logo_final',
    'landing_page',
    'brand_guide',
    'business_card',
    'other',
    'mockup',
    'asset_kit'
  ));
