-- Client Decision Requests — structured client responses (approval / choice /
-- text_input). Per docs/specs/CLIENT-DECISION-REQUESTS.md (approved).
--
-- One reusable table: staff (or automation) create a request scoped to a
-- service_delivery; the client responds in the portal; the response is recorded
-- immutably (a new row per new question — responses are never edited). Business
-- context lives in title/message/options, NOT in the type — only 3 types exist.
--
-- DDL. Apply to SANDBOX via
--   node scripts/apply-migration.js scripts/migrations/20260617-client-decision-requests.sql
-- then promote to production via execute_sql(mode:"write",
--   reason:"migration:20260617-client-decision-requests.sql"). R105.
--
-- RLS: enabled with NO policy → all access is via service-role API routes
-- (lib/supabase-admin), which bypass RLS and enforce staff-vs-client auth +
-- ownership in the handlers. Direct client/anon PostgREST access is denied.
-- Idempotent: IF NOT EXISTS on table + indexes.

CREATE TABLE IF NOT EXISTS client_decision_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_delivery_id uuid NOT NULL REFERENCES service_deliveries(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  account_id          uuid REFERENCES accounts(id) ON DELETE SET NULL,
  request_type        text NOT NULL CHECK (request_type IN ('approval', 'choice', 'text_input')),
  title               text NOT NULL,
  message             text NOT NULL,
  message_it          text,
  options             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'responded', 'expired', 'cancelled')),
  response            jsonb,
  responded_at        timestamptz,
  responded_by        uuid,
  expires_at          timestamptz,
  created_by          text NOT NULL DEFAULT 'system',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  stage_at_creation   text,
  auto_advance_on     text,
  notify_on_response  boolean NOT NULL DEFAULT true
);

-- List all requests for a flow (workspace history), newest first.
CREATE INDEX IF NOT EXISTS idx_cdr_service_delivery
  ON client_decision_requests (service_delivery_id, created_at DESC);

-- A contact's pending requests across flows (portal "my decisions" action items).
CREATE INDEX IF NOT EXISTS idx_cdr_contact_pending
  ON client_decision_requests (contact_id, created_at DESC)
  WHERE status = 'pending';

ALTER TABLE client_decision_requests ENABLE ROW LEVEL SECURITY;
