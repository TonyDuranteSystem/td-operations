-- Decision Memory System — Phase 1 (DB foundation)
-- Semantic store of situations + the decision taken, recalled by vector similarity.
-- pgvector ("vector" extension) is already enabled (verified in sandbox 2026-06-11).
-- Embedding dimension 1536 = OpenAI text-embedding-3-small (native).
-- Apply to sandbox: node scripts/apply-migration.js scripts/migrations/20260611-decision-memory.sql
-- Promote to production (after QA + explicit approval): run each statement below via
--   execute_sql(mode:"write", reason:"migration:20260611-decision-memory.sql")

-- 1. Table -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  situation TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT,
  bot_said TEXT,
  correction_type TEXT,
  tags TEXT[] DEFAULT '{}',
  domain TEXT,
  embedding VECTOR(1536),
  source_type TEXT NOT NULL,
  source_ref TEXT,
  actors TEXT[] DEFAULT '{}',
  confidence FLOAT DEFAULT 0.8,
  times_recalled INT DEFAULT 0,
  times_confirmed INT DEFAULT 0,
  times_contradicted INT DEFAULT 0,
  superseded_by UUID REFERENCES decision_memory(id),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_recalled_at TIMESTAMPTZ
);

-- 2. Match function ----------------------------------------------------------
CREATE OR REPLACE FUNCTION match_decision_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter_domain TEXT DEFAULT NULL,
  filter_status TEXT DEFAULT 'active'
)
RETURNS TABLE (
  id UUID,
  situation TEXT,
  decision TEXT,
  reasoning TEXT,
  tags TEXT[],
  domain TEXT,
  confidence FLOAT,
  source_type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    dm.id, dm.situation, dm.decision, dm.reasoning,
    dm.tags, dm.domain, dm.confidence, dm.source_type,
    dm.created_at,
    1 - (dm.embedding <=> query_embedding) AS similarity
  FROM decision_memory dm
  WHERE dm.status = filter_status
    AND (filter_domain IS NULL OR dm.domain = filter_domain)
    AND 1 - (dm.embedding <=> query_embedding) > match_threshold
  ORDER BY dm.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 3. Indexes -----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_decision_memory_embedding ON decision_memory
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_decision_memory_status ON decision_memory(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_decision_memory_domain ON decision_memory(domain);
CREATE INDEX IF NOT EXISTS idx_decision_memory_tags ON decision_memory USING gin(tags);
