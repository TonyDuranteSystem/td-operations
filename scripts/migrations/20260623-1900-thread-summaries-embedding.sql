-- Persistent worker memory — Phase 2: semantic cross-thread recall ("connect the dots")
-- Adds a vector embedding to thread_summaries + a cosine-similarity match function so the
-- Slack worker can surface RELATED PAST CONVERSATIONS (months old, different threads) when a
-- new message arrives — not just the current thread's own history (Phase 1, recall_thread).
-- Mirrors the proven decision_memory pattern (scripts/migrations/20260611-decision-memory.sql).
-- pgvector ("vector" extension) is already enabled (decision_memory uses VECTOR(1536)).
-- Embedding dimension 1536 = OpenAI text-embedding-3-small (native), same as decision_memory.
--
-- Apply to sandbox: node scripts/apply-migration.js scripts/migrations/20260623-1900-thread-summaries-embedding.sql
-- Then backfill existing rows: node scripts/backfill-thread-summary-embeddings.mjs
-- Promote to production (after sandbox QA + explicit approval): run each statement below via
--   execute_sql(mode:"write", reason:"migration:20260623-1900-thread-summaries-embedding.sql")

-- 1. Embedding column --------------------------------------------------------
ALTER TABLE thread_summaries ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

-- 2. Match function ----------------------------------------------------------
-- Returns the resolved threads most similar to a query embedding, excluding the
-- current thread (so a conversation never "recalls itself"). Only rows that carry
-- an embedding and a non-empty summary are considered. (No account-scoped variant
-- yet: Slack-worker threads are created without accounts_affected populated —
-- verified in 20260621-1510 — so semantic similarity is the recall signal. A
-- structured client filter can be added if/when Slack threads carry accounts.)
CREATE OR REPLACE FUNCTION match_thread_summaries(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.72,
  match_count INT DEFAULT 5,
  exclude_thread_id UUID DEFAULT NULL
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
    AND 1 - (ts.embedding <=> query_embedding) > match_threshold
  ORDER BY ts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 3. Index -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_thread_summaries_embedding ON thread_summaries
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
