-- 20260512-1500-service-catalog-default-context.sql
-- Make per-service "individual / business / ask" default data-driven.
-- Replaces hardcoded INDIVIDUAL_DEFAULT_SLUGS / BUSINESS_DEFAULT_SLUGS /
-- ASK_DEFAULT_SLUGS Set<string> declarations in
-- components/offers/create-offer-dialog.tsx (lines 371-390 pre-fix).
--
-- F1 Flexibility Principle: adding a new individual-level service (e.g.
-- Banking Physical for an individual, 1040NR-only) should populate this
-- column on the catalog row instead of requiring a code edit.
--
-- Values: 'individual' | 'business' | 'ask' | NULL.
-- NULL is the explicit "not set" state; the dialog falls back to 'ask'.

ALTER TABLE public.service_catalog
  ADD COLUMN IF NOT EXISTS default_service_context TEXT
    CONSTRAINT service_catalog_default_service_context_check
    CHECK (default_service_context IS NULL OR default_service_context IN ('individual','business','ask'));

COMMENT ON COLUMN public.service_catalog.default_service_context IS
  'Default for offers.services[].service_context when this service is added to an offer. NULL → dialog falls back to ''ask''.';

-- Backfill preserves the exact behavior of the previous hardcoded slug
-- sets in create-offer-dialog.tsx so deploy is a no-op for UX:
--   INDIVIDUAL_DEFAULT_SLUGS = {'itin'}
--   BUSINESS_DEFAULT_SLUGS   = {'company_formation','client_onboarding',
--                              'ein','banking','closure','cmra', ...}
--   ASK_DEFAULT_SLUGS        = {'tax_return'}
-- (BUSINESS set also contained 'llc_formation','onboarding',
--  'state_ra_renewal','state_annual_report' — those slugs do not exist
--  in the catalog so they were dead entries; not backfilled here.)
-- All other slugs remain NULL → fall through to 'ask' (current behavior).

UPDATE public.service_catalog SET default_service_context = 'individual'
  WHERE slug = 'itin' AND default_service_context IS NULL;

UPDATE public.service_catalog SET default_service_context = 'business'
  WHERE slug IN ('company_formation','client_onboarding','ein','banking','closure','cmra')
    AND default_service_context IS NULL;

UPDATE public.service_catalog SET default_service_context = 'ask'
  WHERE slug = 'tax_return' AND default_service_context IS NULL;
