-- Client Threads — Phase 1 backfill (dev_task 54f89912)
-- Seeds client_threads from the existing CRM conversations log so "pull up by
-- client / topic" has history on day one (prod conversations ~815 rows).
--
-- SCOPE: conversations ONLY. We intentionally do NOT backfill from thread_summaries:
--   the Slack worker creates thread_summaries WITHOUT accounts_affected (verified —
--   lib/ai-agent/slack-claude.ts createThreadSummary call passes no entities), so
--   they carry no client link, and deriving a Slack source_ref from them risks
--   colliding with live tags. conversations is the clean, client-linked source.
--
-- IDEMPOTENT: ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
--   (one client_threads row per conversation id). Safe to re-run.
-- One statement (the sandbox MCP blocks multi-statement mutations). Apply via:
--   execute_sql mode=write reason="migration:20260621-1510-backfill-client-threads-from-conversations.sql"
-- on sandbox first, then (after QA + approval) on production.

INSERT INTO public.client_threads
  (account_id, contact_id, topic_slug, source, source_ref, status, source_kind, confidence, created_at)
SELECT
  c.account_id,
  c.contact_id,
  -- Map the free-text topic to a known topic_templates slug when it matches; else leave NULL.
  (SELECT te.slug
     FROM public.catalog_entries te
    WHERE te.catalog_id = 'topic_templates'
      AND te.status = 'active'
      AND lower(te.slug) = lower(trim(c.topic))
    LIMIT 1) AS topic_slug,
  'crm_log' AS source,
  c.id::text AS source_ref,
  CASE WHEN c.status = 'Archived' THEN 'done' ELSE 'open' END AS status,
  'auto' AS source_kind,
  NULL::real AS confidence,
  c.created_at
FROM public.conversations c
WHERE c.account_id IS NOT NULL OR c.contact_id IS NOT NULL
ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
