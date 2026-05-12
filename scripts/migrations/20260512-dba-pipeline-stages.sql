-- Account fields Phase 1, Part 4: DBA pipeline stages
-- Plan: ops-2026-05-12-account-fields-plan
--
-- Seeds 6 pipeline_stages rows for service_type='DBA'. service_type uses
-- Proper Case to match the existing convention ("EIN", "ITIN", "Tax Return",
-- "Company Formation"). service_type_entry_id is resolved from the DBA
-- catalog entry seeded in the companion migration
-- (20260512-dba-catalog-entry.sql) — that file MUST be applied first.
--
-- Stage spec (Phase 1):
--   1. Data Collection          — client provides trade name + business details
--   2. Application Preparation  — TD prepares the DBA application
--   3. Publication              — fictitious name notice (state-dependent)
--   4. Filed with State         — application submitted
--   5. Registered               — DBA approved
--   6. Renewal Due              — renewal cycle approaching
--
-- All stages keep Phase 1 defaults:
--   auto_advance      = true   (matches EIN / ITIN pattern)
--   notify_client_email = false (no client emails on stage advance — push
--                                only — until Phase 4-equivalent triage)
--   sla_days          = NULL   (no SLA enforcement in Phase 1)
--   requires_approval = false
--
-- Idempotent: skips insert if a row with the same (service_type, stage_order)
-- already exists. Re-applying is safe.
--
-- Apply to SANDBOX first (after 20260512-dba-catalog-entry.sql):
--   node scripts/apply-migration.js scripts/migrations/20260512-dba-pipeline-stages.sql

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
  'DBA',
  v.stage_order,
  v.stage_name,
  v.client_description,
  true,            -- auto_advance
  false,           -- notify_client_email
  false,           -- requires_approval
  ce.id            -- service_type_entry_id → catalog_entries(dba)
FROM (
  VALUES
    (1, 'Data Collection',         'We need the trade name and business details.'),
    (2, 'Application Preparation', 'Preparing the DBA application for your state.'),
    (3, 'Publication',             'Publishing the fictitious name notice (if required by state).'),
    (4, 'Filed with State',        'Application submitted to the state.'),
    (5, 'Registered',              'Your DBA has been approved and registered.'),
    (6, 'Renewal Due',             'Your DBA renewal is approaching.')
) AS v(stage_order, stage_name, client_description)
JOIN catalog_entries ce
  ON ce.catalog_id = 'services' AND ce.slug = 'dba'
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.service_type = 'DBA'
    AND ps.stage_order  = v.stage_order
);
