-- Migration B: Seed Services catalog — first user of the Catalog Framework
-- Part of the Catalog Framework master plan (dev_task 8e25106f, Phase 1)
-- Spec: sysdoc 'ops-2026-05-09-catalog-framework-spec'
-- Vocabulary: sysdoc 'ops-2026-05-08-service-sd-canonical-investigation' (LOCKED 2026-05-08)
--
-- Seeds:
--   1 catalog_definitions row (services)
--   11 Services (sellable)
--   9 SD types (operational tracks — Annual Renewal is NOT an SD, it's a billing cycle)
--   1 deprecated billing cycle artifact (Annual Renewal legacy SD)
--   2 exception entries (Custom, Pending Review)
--   Italian translations for client-facing labels
--   Decision log entries for every seed row
--
-- Apply to SANDBOX first: node scripts/apply-migration.js scripts/migrations/20260509-catalog-seed-services.sql
-- Idempotent: uses ON CONFLICT DO NOTHING on (catalog_id, slug).

-- ─────────────────────────────────────────────────────────────────────────
-- Step 1: catalog_definitions — register the 'services' catalog
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO catalog_definitions (id, display_name, display_name_translations, description, admin_can_add_rows, tags_schema)
VALUES (
  'services',
  'Services & SD Types',
  '{"it": "Servizi e Tipi SD"}',
  'All sellable Services, operational Service Delivery types, and the LLC Management bundle definition. Canonical vocabulary locked 2026-05-08.',
  true,
  '{"valid_tags": ["service", "sd", "sellable", "auto_bundled_with_management", "entry_to_management", "billing_cycle_artifact", "deprecated", "exception"]}'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Step 2: catalog_entries — 11 Services (sellable)
-- Tags: "service" = it's a Service, "sellable" = client can buy it,
--        "entry_to_management" = purchasing this enters LLC Management,
--        "sd" = also creates an SD track, "auto_bundled_with_management" = auto-created with LLC Mgmt
-- ─────────────────────────────────────────────────────────────────────────

-- 1. LLC Formation
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'llc_formation', 'LLC Formation',
  '{"it": "Costituzione LLC"}',
  'Form a new US LLC (Wyoming, Delaware, New Mexico, Florida).',
  'active', '["service", "sellable", "entry_to_management"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 2. Onboarding
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'onboarding', 'Onboarding',
  '{"it": "Onboarding LLC esistente"}',
  'TD takes over management of an existing LLC the client already owns.',
  'active', '["service", "sellable", "entry_to_management"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 3. Tax Return
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'tax_return', 'Tax Return',
  '{"it": "Dichiarazione Fiscale"}',
  'Annual federal/state tax return preparation and filing (1065 / 1120 / 1120-S / 5472).',
  'active', '["service", "sd", "sellable", "auto_bundled_with_management"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 4. ITIN Application
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'itin', 'ITIN Application',
  '{"it": "Richiesta ITIN"}',
  'Individual Taxpayer Identification Number — W-7 preparation, IRS Certified Acceptance Agent.',
  'active', '["service", "sd", "sellable"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 5. EIN Application
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'ein', 'EIN Application',
  '{"it": "Richiesta EIN"}',
  'Employer Identification Number application for an entity.',
  'active', '["service", "sd", "sellable"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 6. Banking
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags, metadata)
VALUES ('services', 'banking', 'Banking',
  '{"it": "Apertura conto bancario"}',
  'Open a US business bank / fintech account (Relay USD or Payset EUR IBAN).',
  'active', '["service", "sd", "sellable"]',
  '{"sd_display_name": "Banking Fintech"}')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 7. CMRA Mailing Address
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'cmra', 'CMRA Mailing Address',
  '{"it": "Indirizzo postale (CMRA)"}',
  'Commercial Mail Receiving Agency — US mailing address service.',
  'active', '["service", "sd", "sellable", "auto_bundled_with_management"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 8. Shipping Service
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'shipping', 'Shipping Service',
  '{}',
  'Forward physical mail and packages received at the CMRA address.',
  'active', '["service", "sellable"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 9. Public Notary
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'notary', 'Public Notary',
  '{}',
  'Notarization of documents, apostille, certified copies.',
  'active', '["service", "sellable"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 10. Company Closure
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'closure', 'Company Closure',
  '{}',
  'LLC dissolution — state filing, IRS closure letter.',
  'active', '["service", "sd", "sellable"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- 11. Consulting Call
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'consulting', 'Consulting Call',
  '{}',
  'One-on-one paid consultation call with the team.',
  'active', '["service", "sellable"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Step 3: catalog_entries — 9 SD types (operational tracks)
-- These are what service_deliveries.service_type references.
-- SD type display names must match EXACTLY what's in the DB today.
-- ─────────────────────────────────────────────────────────────────────────

-- SD: Company Formation (triggered by LLC Formation service)
INSERT INTO catalog_entries (catalog_id, slug, display_name, description, status, tags)
VALUES ('services', 'company_formation', 'Company Formation',
  'SD track: TD forms a new LLC. Triggered by LLC Formation service.',
  'active', '["sd"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- SD: Client Onboarding (triggered by Onboarding service)
INSERT INTO catalog_entries (catalog_id, slug, display_name, description, status, tags)
VALUES ('services', 'client_onboarding', 'Client Onboarding',
  'SD track: TD takes over an existing LLC. Triggered by Onboarding service.',
  'active', '["sd"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- SD: State Annual Report (auto-bundled with LLC Management)
-- Antonio calls this "State Renewal" — it's the state filing that renews the LLC.
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'state_annual_report', 'State Annual Report',
  '{"it": "Rapporto annuale statale"}',
  'SD track: Annual state filing that renews the LLC. Antonio''s "State Renewal". Auto-bundled with LLC Management.',
  'active', '["sd", "auto_bundled_with_management"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- SD: State RA Renewal (auto-bundled with LLC Management)
-- Antonio calls this "RA Renewal" — Registered Agent annual fee.
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, status, tags)
VALUES ('services', 'state_ra_renewal', 'State RA Renewal',
  '{"it": "Rinnovo Registered Agent"}',
  'SD track: Registered Agent annual renewal. Antonio''s "RA Renewal". Auto-bundled with LLC Management.',
  'active', '["sd", "auto_bundled_with_management"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- Note: Tax Return and CMRA Mailing Address are BOTH Services AND SDs.
-- They were already inserted in Step 2 with tags including both "service" and "sd".
-- No duplicate entries needed.

-- ─────────────────────────────────────────────────────────────────────────
-- Step 4: Annual Renewal — DEPRECATED billing cycle artifact
-- NOT an SD. "The Annual Renewal is just a billing cycle, there is no
-- service delivered to the client." — Antonio 2026-05-09
-- 166 sandbox rows exist, ALL status='cancelled', note says
-- "Legacy onboard | Cancelled 2026-04-27: replaced by MSA signing flow."
-- Kept for historical reference. New rows must NOT be created.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO catalog_entries (catalog_id, slug, display_name, description, status, tags, metadata)
VALUES ('services', 'annual_renewal_sd', 'Annual Renewal (Legacy SD)',
  'DEPRECATED. Billing cycle artifact — the 2 client installments + MSA agreement. Lives in annual_agreements + payments + crons. NOT a service delivery. 166 historical rows exist (all cancelled). Do NOT create new rows with this type.',
  'deprecated', '["billing_cycle_artifact", "deprecated"]',
  '{"deprecation_reason": "Replaced by MSA signing flow (2026-04-27)", "historical_row_count": 166, "replacement": "annual_agreements table + annual-renewal-msa cron + annual-installments cron"}')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Step 5: Exception entries — escape valves
-- ─────────────────────────────────────────────────────────────────────────

-- Custom: for one-off services that don't fit any catalog entry.
-- Paired with a custom_label text field on the referencing table.
INSERT INTO catalog_entries (catalog_id, slug, display_name, description, status, tags)
VALUES ('services', 'custom', 'Custom',
  'Escape valve for one-off services. When used, the referencing row must also populate a custom_label text field with the specific description.',
  'exception_only', '["exception"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- Pending Review: for unrecognized values from external sources.
-- Values land here via the anti-corruption layer, awaiting human decision.
INSERT INTO catalog_entries (catalog_id, slug, display_name, description, status, tags)
VALUES ('services', 'pending_review', 'Pending Review',
  'Temporary assignment for unrecognized values from webhooks or external sources. Resolves to a real entry via catalog_pending_review queue.',
  'exception_only', '["exception"]')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Step 6: Decision log entries for seed data
-- Every entry gets a log row recording it was created by migration.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, after_state)
SELECT
  ce.id,
  ce.catalog_id,
  'added',
  'migration',
  CASE
    WHEN ce.slug = 'annual_renewal_sd' THEN 'Seed: deprecated billing cycle artifact. Annual Renewal is NOT an SD — it is the 2 client installments (billing event). 166 historical cancelled rows exist. Replaced by MSA signing flow.'
    WHEN ce.slug = 'custom' THEN 'Seed: exception escape valve for one-off services not in catalog.'
    WHEN ce.slug = 'pending_review' THEN 'Seed: exception escape valve for unrecognized values from external sources.'
    WHEN ce.tags::text LIKE '%auto_bundled_with_management%' AND NOT (ce.tags::text LIKE '%sellable%')
      THEN 'Seed: SD type auto-bundled with LLC Management. Part of the 4-SD bundle (State Annual Report, State RA Renewal, Tax Return, CMRA).'
    WHEN ce.tags::text LIKE '%entry_to_management%'
      THEN 'Seed: sellable Service that is the entry point to LLC Management (formation or onboarding).'
    WHEN ce.tags::text LIKE '%auto_bundled_with_management%' AND ce.tags::text LIKE '%sellable%'
      THEN 'Seed: sellable Service AND SD type, auto-bundled with LLC Management.'
    ELSE 'Seed: canonical Service or SD type per vocabulary locked 2026-05-08.'
  END,
  jsonb_build_object('slug', ce.slug, 'display_name', ce.display_name, 'status', ce.status, 'tags', ce.tags)
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_decision_log cdl
    WHERE cdl.catalog_entry_id = ce.id AND cdl.action = 'added' AND cdl.actor_kind = 'migration'
  );
