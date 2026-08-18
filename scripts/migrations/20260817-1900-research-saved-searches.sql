-- Research Console — saved searches.
-- A saved search freezes a named query (entity + condition list) for reuse.
-- Results themselves are NOT stored here — every open of a saved search
-- re-runs the query live, which is correct for this feature (unlike the
-- LLM research-board concept discussed earlier, a filter search has no
-- narrative text that could go stale against fresher numbers).

CREATE TABLE IF NOT EXISTS research_saved_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  entity TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_field TEXT,
  sort_ascending BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_research_saved_searches_entity ON research_saved_searches(entity);
CREATE INDEX IF NOT EXISTS idx_research_saved_searches_created_at ON research_saved_searches(created_at DESC);
