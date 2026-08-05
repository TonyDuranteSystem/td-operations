-- ============================================================================
-- Cross-conversation recall: an UNLABELLED conversation must never match.
--
-- dev job 86b056b0 (the "activate deep cross-conversation memory" card).
-- Found by the capability audit + a full council pass, 2026-08-05.
--
-- THE PROBLEM THIS CLOSES
-- `thread_summaries.client_key` overloads NULL to mean two opposite things:
--   (a) "this conversation is not about any client" — safe to share, and
--   (b) "we never recorded who this is about" — which is most of the table.
-- The previous RPC treated both as (a):
--     WHEN filter_client_key IS NOT NULL
--       THEN ts.client_key = filter_client_key OR ts.client_key IS NULL
--       ELSE ts.client_key IS NULL
-- so an unlabelled row matched in EVERY context, client-scoped or not.
--
-- On production today that is 332 of 388 rows unlabelled, 75 of which contain a
-- real client company name in their summary text. Backfilling embeddings under
-- the old rule would have made one client's conversation surface while staff work
-- on a different client — on panels that draft and send client-facing messages.
--
-- WHY "JUST LABEL THEM" IS NOT THE FIX ON ITS OWN
-- Only 29 of the 332 are recoverable from message context; 234 are Slack-era rows
-- with no attribution left at all. And the write side kept minting new unlabelled
-- rows: the Inbox surface never supplies a client key (it is an email thread, not
-- a client), so the unlabelled pool regrows every week. A one-time cleanup would
-- have looked like a fix and rotted within weeks.
--
-- THE RULE, AFTER THIS MIGRATION
--   * client context     → match ONLY rows labelled with that exact client.
--   * non-client context → match NOTHING.
-- An unlabelled row is inert everywhere. That is deliberately conservative: it
-- costs recall on conversations we cannot attribute, and it makes a cross-client
-- leak impossible by construction rather than by careful data hygiene.
--
-- SAFE TO APPLY WHILE THE FEATURE IS OFF. `THREAD_RECALL_SEMANTIC_ENABLED` is not
-- set on production, so nothing calls this function today; applying it now means
-- the switch is safe to flip whenever Antonio decides, with NOTHING backfilled.
-- It only ever NARROWS what can be returned, so it cannot introduce a leak.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.match_thread_summaries(
  query_embedding vector,
  match_threshold double precision DEFAULT 0.72,
  match_count integer DEFAULT 5,
  exclude_thread_id uuid DEFAULT NULL::uuid,
  filter_client_key text DEFAULT NULL::text
)
RETURNS TABLE(
  thread_id uuid,
  thread_type text,
  title text,
  outcome text,
  summary_text text,
  tags text[],
  created_at timestamp with time zone,
  resolved_at timestamp with time zone,
  similarity double precision
)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT ts.thread_id, ts.thread_type, ts.title, ts.outcome, ts.summary_text,
    ts.tags, ts.created_at, ts.resolved_at,
    1 - (ts.embedding <=> query_embedding) AS similarity
  FROM thread_summaries ts
  WHERE ts.embedding IS NOT NULL AND ts.summary_text IS NOT NULL
    AND (exclude_thread_id IS NULL OR ts.thread_id <> exclude_thread_id)
    -- ⛔ THE WHOLE POINT OF THIS MIGRATION.
    -- An unlabelled row (client_key IS NULL) matches NOTHING, in either branch.
    -- Previously it matched EVERYTHING, in both.
    AND ts.client_key IS NOT NULL
    AND filter_client_key IS NOT NULL
    AND ts.client_key = filter_client_key
    AND 1 - (ts.embedding <=> query_embedding) > match_threshold
  ORDER BY ts.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

COMMENT ON FUNCTION public.match_thread_summaries IS
  'Cross-conversation recall. Returns ONLY conversations labelled with the exact client in scope; an unlabelled conversation is inert and a non-client context matches nothing. Narrowed 2026-08-05 (dev job 86b056b0) — the previous version treated an unlabelled row as globally shareable, which would have surfaced one client''s history inside another client''s conversation.';
