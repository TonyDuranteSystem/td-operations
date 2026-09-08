-- Adds an OPTIONAL portal-chat companion to the existing per-stage milestone
-- email (pipeline_stages.notify_client_email). Purely additive: does not
-- replace or affect the email. client_chat_topic lets each stage pin a
-- stable topic label so the automatic message lands in the client's
-- existing conversation instead of a computed, drifting one — see
-- docs/systems/flows.md (2026-09-08) for why buildFlowTopic()'s year suffix
-- is unsafe for this.
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS notify_client_chat boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_chat_topic text;

-- Turn it on for exactly ITIN's "Submitted to IRS" stage. Scoped by BOTH
-- service_type AND stage_name deliberately — a stage-name-only scope has
-- already silently rotted once for Company Formation's notify_client_email
-- rollout after a later pipeline restructure renamed its stages out from
-- under it (found live in production, 2026-09-08 investigation).
UPDATE pipeline_stages
SET notify_client_chat = true,
    client_chat_topic = 'ITIN'
WHERE service_type = 'ITIN' AND stage_name = 'Submitted to IRS';
