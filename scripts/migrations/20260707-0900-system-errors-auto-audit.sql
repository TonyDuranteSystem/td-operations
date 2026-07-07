-- Error auto-audit system (dev_task: offer dialog "Unknown error" incident 2026-07-07).
-- One row per distinct error fingerprint; repeats increment occurrence_count
-- instead of inserting new rows (lesson from the audit-health-check task spam).
-- Service-role access only: RLS enabled with no policies.

CREATE TABLE IF NOT EXISTS system_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('client', 'server')),
  route TEXT NOT NULL,
  method TEXT,
  http_status INTEGER,
  page_path TEXT,
  user_email TEXT,
  message TEXT NOT NULL,
  body_snippet TEXT,
  context JSONB,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'diagnosed', 'resolved', 'ignored')),
  diagnosis TEXT,
  suggested_fix TEXT,
  diagnosed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE system_errors ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_system_errors_status_last_seen
  ON system_errors (status, last_seen DESC);
