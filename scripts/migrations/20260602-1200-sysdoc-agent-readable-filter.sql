-- Filtered agent-read path for system_docs (Hermes operating-agent).
-- Adds an explicit, deny-by-default agent_readable gate + reviewer metadata,
-- and a read-access audit log. Pairs with the sysdoc_read_allowed MCP tool.
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Do NOT promote to production
-- without explicit approval. Raw sysdoc_read remains the unfiltered path and
-- is never exposed to restricted agents.

ALTER TABLE system_docs
  ADD COLUMN IF NOT EXISTS agent_readable             boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_readable_reviewed_by text,
  ADD COLUMN IF NOT EXISTS agent_readable_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_readable_notes       text;

CREATE TABLE IF NOT EXISTS sysdoc_read_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text,
  allowed           boolean,
  caller            text,
  redaction_applied boolean,
  created_at        timestamptz NOT NULL DEFAULT now()
);
