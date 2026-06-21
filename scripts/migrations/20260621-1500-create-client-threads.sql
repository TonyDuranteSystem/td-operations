-- Client Threads — Phase 1 (tracking table)
-- Purpose-built layer linking a support conversation to a client (account | contact | lead)
-- + a topic, pointing at where the conversation lives (a Slack thread now; portal/email/call later).
-- Does NOT duplicate message content — it references it (thread_id / source_ref).
-- Plan: ~/.claude/plans/curried-imagining-zephyr.md  |  dev_task 54f89912
--
-- Apply to sandbox: node scripts/apply-migration.js scripts/migrations/20260621-1500-create-client-threads.sql
--   (or, when .env.local is absent in a worktree, via the sandbox MCP:
--    execute_sql mode=write reason="migration:20260621-1500-create-client-threads.sql")
-- Promote to production (after QA + explicit approval): execute_sql mode=write
--   reason="migration:20260621-1500-create-client-threads.sql"

CREATE TABLE IF NOT EXISTS public.client_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO (polymorphic, nullable FKs). At least one must be set.
  -- account_id + contact_id may co-exist (a contact who belongs to an account);
  -- a lead typically stands alone (not yet an account/contact).
  account_id   uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id   uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  lead_id      uuid REFERENCES public.leads(id)    ON DELETE SET NULL,

  -- WHAT (catalog slug: 'services' or 'support_topics'). Nullable until classified.
  topic_slug   text,

  -- WHERE the conversation lives.
  source       text NOT NULL DEFAULT 'slack',           -- 'slack' | 'crm_log' | 'portal' | 'email' | 'call'
  source_ref   text,                                    -- e.g. "<channelId>:<thread_ts>" for slack; row id for crm_log
  thread_id    uuid,                                    -- loose pointer to thread_summaries.thread_id (no FK: avoids insert-order coupling)

  -- Lifecycle (catalog-driven status arrives in Phase 2; default 'open' for now).
  status       text NOT NULL DEFAULT 'open',
  summary      text,                                    -- Phase 2 auto-summary

  -- Provenance (keeps auto-guesses out of "trusted" until a human confirms).
  source_kind  text NOT NULL DEFAULT 'auto' CHECK (source_kind IN ('auto','manual')),
  confidence   real,                                    -- 0..1 for auto-tags
  confirmed_by uuid,                                    -- auth user id; null until confirmed/corrected by a human
  confirmed_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- At least one entity must be tagged.
  CONSTRAINT client_threads_entity_present
    CHECK (num_nonnulls(account_id, contact_id, lead_id) >= 1)
);

-- Structural idempotency: one row per (source, source_ref).
-- Partial so multiple rows with NULL source_ref are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS client_threads_source_ref_uniq
  ON public.client_threads (source, source_ref)
  WHERE source_ref IS NOT NULL;

-- Retrieval indexes (pull up by client / topic / source / recency).
CREATE INDEX IF NOT EXISTS client_threads_account_idx ON public.client_threads (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_threads_contact_idx ON public.client_threads (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_threads_lead_idx    ON public.client_threads (lead_id)    WHERE lead_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_threads_topic_idx   ON public.client_threads (topic_slug);
CREATE INDEX IF NOT EXISTS client_threads_source_idx  ON public.client_threads (source);
CREATE INDEX IF NOT EXISTS client_threads_status_idx  ON public.client_threads (status);
CREATE INDEX IF NOT EXISTS client_threads_created_idx ON public.client_threads (created_at DESC);

-- RLS: enable with NO policies → denies all anon/authenticated PostgREST access.
-- The table is internal/staff-only; every read/write goes through the service role
-- (server components use supabaseAdmin; the Slack worker uses supabaseAdmin), which
-- bypasses RLS. This prevents the public anon key from reading client names/topics.
ALTER TABLE public.client_threads ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.client_threads IS
  'Client Threads (dev_task 54f89912): tags a support conversation with a client (account|contact|lead) + topic, pointing at where it lives. Single source for client<->topic<->location. Feeds Decision Memory in a later phase. See docs/systems + plan curried-imagining-zephyr.';
