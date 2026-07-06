-- TD Communication — Phase 15 (Social Sharing Kit): allow the client-facing
-- social-kit deliverable type.
--
-- Phase 12 already generates platform-sized brand assets client-side and can SAVE
-- them as an internal 'asset_kit' deliverable (never shown to the client). Phase 15
-- adds a distinct, CLIENT-FACING deliverable type:
--   - 'social_kit' — a zip of platform-sized social assets + branded post templates,
--                     RELEASED to the client for self-serve download in the portal.
--
-- Why a new type rather than reusing 'asset_kit': the portal queries exactly
-- `type='social_kit' AND released_at IS NOT NULL` to surface the client download,
-- and 'asset_kit'/'mockup' remain internal-scratch (excluded from every client
-- surface). Keeping them separate means the client gate can never accidentally
-- expose an internal asset-kit save.
--
-- Additive: extends the existing type CHECK. No existing rows/behaviour change.
-- The CHECK from 20260628-1600 (extended by 20260702-1600) is auto-named
-- td_comm_deliverables_type_check; we drop-if-exists and re-add with the extra
-- value (idempotent).

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
    'asset_kit',
    'social_kit'
  ));
