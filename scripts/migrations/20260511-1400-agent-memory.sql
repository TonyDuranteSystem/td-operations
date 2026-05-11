-- Agent memory: persistent notes the AI Agent saves between chat sessions
CREATE TABLE IF NOT EXISTS agent_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       TEXT NOT NULL DEFAULT 'global',  -- 'global' | 'client:{account_id}'
  key         TEXT NOT NULL,                   -- short identifier, e.g. 'fee_waiver_policy'
  content     TEXT NOT NULL,                   -- the memory text
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (scope);
