-- Live code-task session viewer (item 3).
-- Two tables back the interactive viewer for a Slack→Mac Mini code task:
--   code_task_events  — the runner streams each Claude Code session event here as
--                       it happens; the CRM viewer tails it live (Supabase realtime).
--   code_task_inputs  — messages the admin types into the viewer mid-session; the
--                       runner delivers them into the live session's stdin.
-- A code task is an agent_messages row (recipient='code_runner'); task_id refers to
-- agent_messages.id. The session_id assigned to the headless `claude` run is stored
-- on agent_messages.context_json.session_id (jsonb, no column needed).

CREATE TABLE IF NOT EXISTS code_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  seq integer NOT NULL,
  event_type text NOT NULL,            -- assistant | tool_use | tool_result | result | system | milestone
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_code_task_events_task_seq ON code_task_events (task_id, seq);

CREATE TABLE IF NOT EXISTS code_task_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  seq integer NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending | delivered
  created_by text,                          -- admin email
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_code_task_inputs_task_status ON code_task_inputs (task_id, status);
