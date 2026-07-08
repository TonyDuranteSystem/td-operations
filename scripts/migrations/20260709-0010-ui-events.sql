-- Cross-tab live updates (Antonio 2026-07-08: "no hard refresh — updates
-- shown immediately in all tabs, all machines").
--
-- ui_events is a tiny WAKE-UP bus: server write paths emit a row after
-- changing something; every open dashboard tab subscribes via
-- supabase_realtime and refreshes the affected data. Rows carry a kind +
-- optional ids — NO business content. Pruned daily by gmail-watch-renew.

CREATE TABLE IF NOT EXISTS ui_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,              -- 'todo' | 'tasks' | … (see lib/ui-events.ts)
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ui_events IS
  'Dashboard live-update bus (wake-up signals only, no business content). Written by emitUiEvent (lib/ui-events.ts), consumed by components/dashboard/ui-event-listener.tsx via supabase_realtime, pruned by the gmail-watch-renew cron.';

CREATE INDEX IF NOT EXISTS idx_ui_events_created ON ui_events (created_at DESC);

-- Staff-only realtime (same policy shape as gmail_push_events)
ALTER TABLE ui_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ui_events_staff_select ON ui_events;
CREATE POLICY ui_events_staff_select ON ui_events
  FOR SELECT TO authenticated
  USING (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'ui_events'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE ui_events';
  END IF;
END $$;
