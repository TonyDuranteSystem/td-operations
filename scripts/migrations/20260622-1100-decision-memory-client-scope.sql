-- Decision Memory — Phase 3 Part 1: per-client scope (dev_task 54f89912)
-- Adds a client_key ("account:<id>" | "contact:<id>" | "lead:<id>") to each memory,
-- plus a SEPARATE recall function scoped to one client, so the worker can recall
-- "what we know about THIS client" before answering. The original match_decision_memory
-- is left untouched (zero risk to existing recall) — we add a sibling function.
--
-- Apply to sandbox: sandbox MCP, one statement each (the MCP can CREATE FUNCTION but
-- not DROP FUNCTION). Promote to production in the Supabase SQL editor.

ALTER TABLE public.decision_memory ADD COLUMN IF NOT EXISTS client_key text;
CREATE INDEX IF NOT EXISTS idx_decision_memory_client_key ON public.decision_memory(client_key);

-- Sibling of match_decision_memory, restricted to one client_key. Lower default
-- threshold (0.4) like the auto-recall path, so it surfaces loosely-related lessons.
CREATE OR REPLACE FUNCTION match_decision_memory_client(
  query_embedding VECTOR(1536),
  filter_client_key TEXT,
  match_threshold FLOAT DEFAULT 0.4,
  match_count INT DEFAULT 5,
  filter_status TEXT DEFAULT 'active'
)
RETURNS TABLE (
  id UUID, situation TEXT, decision TEXT, reasoning TEXT, tags TEXT[],
  domain TEXT, confidence FLOAT, source_type TEXT, created_at TIMESTAMPTZ, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT dm.id, dm.situation, dm.decision, dm.reasoning, dm.tags, dm.domain, dm.confidence, dm.source_type, dm.created_at,
    1 - (dm.embedding <=> query_embedding) AS similarity
  FROM decision_memory dm
  WHERE dm.status = filter_status
    AND dm.client_key = filter_client_key
    AND 1 - (dm.embedding <=> query_embedding) > match_threshold
  ORDER BY dm.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
