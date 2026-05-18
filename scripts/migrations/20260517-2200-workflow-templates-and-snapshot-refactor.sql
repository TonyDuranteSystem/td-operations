-- Workflow flexibility pass — pre-ship companion to Slices 8-10.
--
-- Backfills `task_title_template` + `description_template` on the 6
-- catalog-driven workflow rows reachable via dispatchers (form_submission +
-- sd_created). Chain-spawned workflows (banking_physical_progress, demo_review,
-- itin_await_client_mailing, itin_caa_certify_and_mail, itin_irs_processing,
-- itin_number_received) build their titles inside handler code (`spawn_task.
-- task_title`) and don't need templates.
--
-- itin_review is intentionally SKIPPED because its title depends on a runtime
-- boolean (`docsGenerated`) computed in the route — that branching isn't
-- expressible as a `{token}` interpolation. The caller-provided literal stays
-- authoritative for that workflow.
--
-- Token convention (lib/template-interpolation.ts): `{name}` style, alphanum
-- + underscore + dot. Strict interpolation: any missing/empty token returns
-- null at runtime → dispatcher falls back to the caller's literal title.
-- That means this migration is SAFE to apply before code deploys — if the
-- code that consumes the templates isn't running yet, nothing happens.
--
-- Idempotent via jsonb_set with create_missing=true. Re-running rewrites the
-- two fields to the same values.

BEGIN;

-- ─── form_submission triggers ────────────────────────────────────────────

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{task_title_template}', '"Review Payset banking form — {company_name}"'::jsonb, true),
  '{description_template}',
  '"Banking PAYSET form completed by client for {company_name}. Review the data, then click Approve & Apply (workflow action) to mark reviewed and spawn the next-step task."'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'banking_review_payset';

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{task_title_template}', '"Review Relay banking form — {company_name}"'::jsonb, true),
  '{description_template}',
  '"Banking RELAY form completed by client for {company_name}. Review the data, then click Approve & Apply (workflow action) to mark reviewed and spawn the next-step task."'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'banking_review_relay';

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{task_title_template}', '"Review tax form data -- {company_name} ({tax_year})"'::jsonb, true),
  '{description_template}',
  '"Client {company_name} has submitted tax data for {tax_year}. Entity type: {entity_type}. Review the data, then click Approve & Apply Changes to enqueue the CRM reconciliation job."'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'tax_form_review';

-- ─── sd_created triggers ─────────────────────────────────────────────────
--
-- Context available to interpolation = the SD delivery row spread into the
-- task_meta returned by createSD's build_task_meta callback. That means
-- `service_type`, `service_name`, `account_id`, `contact_id`, `sd_stage`,
-- `service_delivery_id` are all reachable.
--
-- Note `service_name` can be NULL on the SD row; strict interpolation will
-- fall back to caller's literal in that case, which today is
-- `${service_type} — ${service_name || service_type}`. So behavior is
-- preserved when service_name is missing.

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{task_title_template}', '"{service_type} — {service_name}"'::jsonb, true),
  '{description_template}',
  '"Service delivery created: {service_type}. Use the action buttons below to advance the lifecycle."'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'closure_progress';

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{task_title_template}', '"{service_type} — {service_name}"'::jsonb, true),
  '{description_template}',
  '"Service delivery created: {service_type}. Use the action buttons below to advance the lifecycle."'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'formation_progress';

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{task_title_template}', '"{service_type} — {service_name}"'::jsonb, true),
  '{description_template}',
  '"Service delivery created: {service_type}. Use the action buttons below to advance the lifecycle."'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'onboarding_progress';

COMMIT;
