-- TD Communication — Geometry tool (Design Tools 5th tab): allow the internal
-- 'geometry' design-asset deliverable type.
--
-- Cris's Geometry tool produces a corner-treatment SPECIMEN (a shaped container +
-- labeled parameters) that she can SAVE as an internal design asset (SVG, and PNG)
-- via the isolated design-assets path (insertDesignAsset — NO advanceStatus, never
-- arms the Phase 7 client reveal). Like 'mockup'/'asset_kit', 'geometry' is
-- INTERNAL-ONLY: excluded from every client surface (listReleasedConceptsForClient)
-- and kept out of the manual-upload dropdown.
--
-- Why a new type: keeps geometry saves grouped/versioned on their own and cleanly
-- excluded from the client reveal, exactly as mockup/asset_kit are.
--
-- Additive + idempotent: extends the existing auto-named type CHECK
-- (td_comm_deliverables_type_check) via drop-if-exists + re-add. No existing
-- rows/behaviour change. DDL-BEFORE-CODE: run this before deploying code that
-- emits type='geometry' (else the insert fails the CHECK, 23514).

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
    'social_kit',
    'geometry'
  ));
