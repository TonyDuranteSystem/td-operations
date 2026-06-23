-- Flow Workspaces — production schema promotion (additive columns only).
--
-- Adds the 6 columns the flow-workspace feature needs, matching the ACTUAL
-- sandbox schema (verified 2026-06-15 via information_schema, not the task's
-- hand-written SQL):
--   documents.service_delivery_id  -> FK service_deliveries(id) ON DELETE SET NULL
--   documents.flow_stage           -> text (no migration file existed; verified live)
--   portal_messages.service_delivery_id -> FK service_deliveries(id) ON DELETE SET NULL
--   action_log.service_delivery_id -> uuid, NO FK (matches sandbox: no FK constraint)
--   pipeline_stages.stage_layout   -> jsonb
--   pipeline_stages.client_notification_message -> text
-- Partial indexes are the SIMPLE (service_delivery_id) WHERE NOT NULL form that
-- sandbox actually has (the earlier per-feature migration files used a composite
-- index for portal_messages; sandbox's live index is simple — this matches live).
--
-- Fully additive + idempotent (IF NOT EXISTS). No data changes, no behavior
-- change on its own. Safe to run repeatedly. Production-only promotion; sandbox
-- already has these columns, so applying to sandbox is a no-op.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS service_delivery_id uuid REFERENCES service_deliveries(id) ON DELETE SET NULL;
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS flow_stage text;

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS service_delivery_id uuid REFERENCES service_deliveries(id) ON DELETE SET NULL;

ALTER TABLE action_log
  ADD COLUMN IF NOT EXISTS service_delivery_id uuid;

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS stage_layout jsonb;
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS client_notification_message text;

CREATE INDEX IF NOT EXISTS idx_documents_service_delivery
  ON documents(service_delivery_id) WHERE service_delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_messages_service_delivery
  ON portal_messages(service_delivery_id) WHERE service_delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_log_service_delivery
  ON action_log(service_delivery_id) WHERE service_delivery_id IS NOT NULL;
