-- Lead window: "client or lead?" question (dev job 6fc63c52, Antonio 2026-11-02, mockup approved).
-- One row per (lead, candidate client contact) the system was not sure about. It keeps the reasons it showed and
-- Antonio's answer, so the same question is never asked twice and the guess can learn.
--   status: open | client | new_lead | later   (values live in code: lib/leads/client-context.ts; no CHECK list on purpose)
-- The code works before this runs (the question card and tag just do not appear). Idempotent.
-- UNDO: scripts/migrations/20261102-0200-lead-client-checks.UNDO.sql

CREATE TABLE IF NOT EXISTS public.lead_client_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'open',
  reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  answered_by text,
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_client_checks_pair ON public.lead_client_checks (lead_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_lead_client_checks_open ON public.lead_client_checks (lead_id) WHERE status IN ('open', 'later');
ALTER TABLE public.lead_client_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_client_checks FROM anon, authenticated;

SELECT public.marketing_lock_all_tables();

-- verify
SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lead_client_checks' ORDER BY ordinal_position;
