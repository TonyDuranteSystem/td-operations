-- Worker WS4.1 (council redo, dev job a9477d06) — CLIENT SCOPE on cross-thread recall.
--
-- The cross-conversation semantic recall (20260623-1900) matched purely on
-- embedding similarity with NO client filter (its own comment: "No account-scoped
-- variant yet ... A structured client filter can be added if/when threads carry
-- accounts."). Now that CRM worker threads DO carry a client key, promoting that
-- recall as-is would let client X's thread summary surface in client Y's
-- conversation — a cross-client data leak (council BLOCKER: do NOT flip the
-- semantic flag ON until this scope filter exists). This migration adds the scope
-- column + a scoped match function.
--
-- ORDER: this runs AFTER 20260623-1900 (which adds the embedding column + the
-- base match_thread_summaries). Apply to sandbox first:
--   node scripts/apply-migration.js scripts/migrations/20260717-2100-thread-summaries-client-scope.sql
-- Promote to prod (after 20260623-1900, sandbox QA + explicit approval) via
--   execute_sql(mode:"write", reason:"migration:20260717-2100-thread-summaries-client-scope.sql")

-- 1. Client-scope column -----------------------------------------------------
-- Canonical form "account:<id>" | "contact:<id>" (matches the worker's
-- client-scoped memory key), or NULL for a non-client / internal thread.
ALTER TABLE thread_summaries ADD COLUMN IF NOT EXISTS client_key TEXT;
CREATE INDEX IF NOT EXISTS idx_thread_summaries_client_key
  ON thread_summaries (client_key) WHERE client_key IS NOT NULL;

-- 2. Scoped match function ---------------------------------------------------
-- Replaces the 4-arg version with a 5-arg version that takes filter_client_key.
-- Isolation rule:
--   * In a CLIENT context (filter_client_key NOT NULL): return only that client's
--     own threads OR global (client_key IS NULL) threads — NEVER another client's.
--   * In a NON-client context (filter_client_key NULL): return only global threads
--     — don't pull any specific client's thread into a general conversation.
DROP FUNCTION IF EXISTS match_thread_summaries(VECTOR(1536), FLOAT, INT, UUID);

CREATE OR REPLACE FUNCTION match_thread_summaries(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.72,
  match_count INT DEFAULT 5,
  exclude_thread_id UUID DEFAULT NULL,
  filter_client_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  thread_id UUID,
  thread_type TEXT,
  title TEXT,
  outcome TEXT,
  summary_text TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.thread_id, ts.thread_type, ts.title, ts.outcome, ts.summary_text,
    ts.tags, ts.created_at, ts.resolved_at,
    1 - (ts.embedding <=> query_embedding) AS similarity
  FROM thread_summaries ts
  WHERE ts.embedding IS NOT NULL
    AND ts.summary_text IS NOT NULL
    AND (exclude_thread_id IS NULL OR ts.thread_id <> exclude_thread_id)
    AND (
      CASE
        WHEN filter_client_key IS NOT NULL
          THEN ts.client_key = filter_client_key OR ts.client_key IS NULL
        ELSE ts.client_key IS NULL
      END
    )
    AND 1 - (ts.embedding <=> query_embedding) > match_threshold
  ORDER BY ts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
