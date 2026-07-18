-- Business Brain P1 — PRIVATE-FACTS WALL (council, dev job 203cda1a). URGENT.
--
-- The global lesson-recall RPC `match_decision_memory` (injected into EVERY worker
-- turn on every surface + the dashboard agent via buildAutoRecallSuffix) filters
-- only status/domain/similarity — NOT client_key. So a CLIENT-SCOPED lesson (a
-- private note about one client) is in the candidate pool for every OTHER client's
-- recall. Verified live: 3 client-scoped rows already exist in production →
-- live, bounded cross-client private-data exposure.
--
-- FIX (architect's stronger shape): make the GLOBAL recall return GLOBAL rows ONLY
-- (`client_key IS NULL`). Own-client recall is already delivered by the separate,
-- dedicated `match_decision_memory_client` RPC (+ buildClientRecallSuffix), so this
-- needs no new param and is a HARD, non-probabilistic guarantee: the global path
-- can never return a client-scoped row, period. Same signature → CREATE OR REPLACE
-- (no DROP). This is the foundation for save-by-default client-scoped capture.
--
-- Apply to sandbox: node scripts/apply-migration.js scripts/migrations/20260718-0100-decision-memory-global-recall-isolation.sql
-- Promote to prod (Supabase SQL editor, R105): run the CREATE OR REPLACE below.

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
    -- WALL: global recall = GLOBAL knowledge only. Client-scoped rows are
    -- reachable ONLY via match_decision_memory_client (own-client context).
    AND dm.client_key IS NULL
    AND (filter_domain IS NULL OR dm.domain = filter_domain)
    AND 1 - (dm.embedding <=> query_embedding) > match_threshold
  ORDER BY dm.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
