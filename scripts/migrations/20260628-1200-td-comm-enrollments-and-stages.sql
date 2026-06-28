-- TD Communication Phase 2 — Project Pipeline foundation
--
-- Adds the enrollment table that backs Cris's creative-studio pipeline board
-- at /collab, plus the TD Communication pipeline stage vocabulary.
--
-- DESIGN — an enrollment's "subject" (the client a creative project is for) can
-- be ANY actor: an account (company), a contact (individual), a lead, or a
-- partner. This mirrors the established polymorphic-subject convention used by
-- `offers` (lead/account/contact/partner) and `client_threads`
-- (account/contact/lead + num_nonnulls >= 1). Independent nullable FKs keep
-- real referential integrity and stay extensible — a new actor type is one more
-- nullable column. The board groups by `status` (always present); the linked
-- service_delivery (nullable) is enrichment only.
--
-- RLS — like comm_conversations, this table is RLS ON with NO policy: the
-- browser never queries it directly; all reads/writes go through the service
-- role (supabaseAdmin) after an explicit auth check in app/api/td-communication/*.

-- 1) Enrollments -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS td_comm_enrollments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic subject — at least one must be set.
  account_id          uuid REFERENCES accounts(id)          ON DELETE SET NULL,
  contact_id          uuid REFERENCES contacts(id)          ON DELETE SET NULL,
  lead_id             uuid REFERENCES leads(id)             ON DELETE SET NULL,
  partner_id          uuid REFERENCES client_partners(id)   ON DELETE SET NULL,

  -- Optional linked service delivery for workspace/stage tracking (enrichment).
  service_delivery_id uuid REFERENCES service_deliveries(id) ON DELETE SET NULL,

  client_type         text CHECK (client_type IN ('new_brand', 'rebrand')),
  package_slug        text,

  status              text NOT NULL DEFAULT 'enrolled'
                        CHECK (status IN (
                          'enrolled', 'form_submitted', 'in_progress',
                          'concept_ready', 'approved', 'revision',
                          'delivered', 'cancelled'
                        )),

  form_data           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The TD Communication chat thread for this project (the partner channel).
  conversation_id     uuid REFERENCES comm_conversations(id) ON DELETE SET NULL,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT td_comm_enrollments_subject_present
    CHECK (num_nonnulls(account_id, contact_id, lead_id, partner_id) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_status
  ON td_comm_enrollments (status);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_account
  ON td_comm_enrollments (account_id);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_contact
  ON td_comm_enrollments (contact_id);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_lead
  ON td_comm_enrollments (lead_id);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_partner
  ON td_comm_enrollments (partner_id);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_conversation
  ON td_comm_enrollments (conversation_id);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_created
  ON td_comm_enrollments (created_at DESC);

ALTER TABLE td_comm_enrollments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE td_comm_enrollments IS
  'TD Communication Phase 2: creative-project enrollments backing the /collab pipeline board. Polymorphic subject (account/contact/lead/partner, >=1). RLS ON, no policy — service-role reads/writes only after API auth.';

-- 2) TD Communication pipeline stages ----------------------------------------
-- Client-facing stage vocabulary for the linked SD / client portal view. The
-- board itself groups by td_comm_enrollments.status; these provide the
-- friendly labels and ordering. Idempotent via WHERE NOT EXISTS (the guard
-- short-circuits the whole INSERT when any TD Communication stage exists).
-- INSERT...SELECT form (not a DO block) so it runs through both psql and the
-- execute_sql MCP path used for production promotion (R105).
INSERT INTO pipeline_stages
  (service_type, stage_order, stage_name, client_label, client_visible, board_visible, color, sla_days)
SELECT * FROM (VALUES
  ('TD Communication', 1, 'Package Selected',          'Package selected',     true, true, '#a1a1aa', NULL::int),
  ('TD Communication', 2, 'Form Submitted',            'Details received',     true, true, '#3b82f6', 2),
  ('TD Communication', 3, 'Brand Concept In Progress', 'Creating your brand',  true, true, '#3b82f6', 7),
  ('TD Communication', 4, 'Concept Ready',             'Ready for review',     true, true, '#f59e0b', 3),
  ('TD Communication', 5, 'Concept Approved',          'Approved',             true, true, '#10b981', NULL),
  ('TD Communication', 6, 'Revision In Progress',      'Working on revisions', true, true, '#f59e0b', 5),
  ('TD Communication', 7, 'Final Delivery',            'Your brand is ready!', true, true, '#10b981', NULL)
) AS v(service_type, stage_order, stage_name, client_label, client_visible, board_visible, color, sla_days)
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE service_type = 'TD Communication');
