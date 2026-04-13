-- Workstream B: Standalone Business Tax Return Redesign — Onboarding-First Intake
-- Applied: 2026-04-13
-- Dev task: 1efa6b15-f98c-4148-ae8f-c5f9feb5903b

-- 1. New pipeline stages for Tax Return intake path (standalone business only)
-- Existing stages (1-8) are unchanged.
INSERT INTO pipeline_stages (service_type, stage_name, stage_order, auto_tasks)
VALUES
  ('Tax Return', 'Company Data Pending', -1, '[]'::jsonb),
  ('Tax Return', 'Paid - Awaiting Data', 0, '[]'::jsonb);

-- 2. Dedicated submission table for company_info wizard (does NOT reuse onboarding_submissions)
CREATE TABLE company_info_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  lead_id uuid,
  contact_id uuid,
  account_id uuid,
  entity_type text NOT NULL DEFAULT 'SMLLC',
  state text NOT NULL DEFAULT 'NM',
  language text NOT NULL DEFAULT 'en',
  prefilled_data jsonb DEFAULT '{}',
  submitted_data jsonb DEFAULT '{}',
  changed_fields jsonb DEFAULT '{}',
  upload_paths text[] DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  opened_at timestamptz,
  completed_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  access_code text DEFAULT encode(gen_random_bytes(4), 'hex')
);

ALTER TABLE company_info_submissions ENABLE ROW LEVEL SECURITY;
