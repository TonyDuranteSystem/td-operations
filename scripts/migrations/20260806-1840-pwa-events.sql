-- pwa_events — anonymous install-funnel telemetry (Phase 2, dev job 8f38add1)
--
-- Design (council-fixed, plan v2 D6):
--  * This table is FUNNEL TELEMETRY ONLY. Per-account "receiving push" truth
--    is derived LIVE from push_subscriptions (self-pruning on dead endpoints,
--    lib/portal/web-push.ts) — never from a stored flag here.
--  * Service-role writes only: RLS enabled with NO policies, so the anon key
--    can neither read nor write. All writes go through
--    POST /api/portal/pwa-events, which validates the enum server-side.
--  * contact_id is server-derived from the session (never client-supplied);
--    account attribution lives on push_subscriptions, not here.
--  * iOS attribution limit (honest by design): iOS fires no appinstalled and
--    partitions storage, so per-src install rows only exist for Android;
--    iOS installs surface as standalone_launch/standalone_authenticated
--    without src.

CREATE TABLE IF NOT EXISTS pwa_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL CHECK (event IN (
    'page_view',
    'installed',
    'standalone_launch',
    'standalone_authenticated'
  )),
  src text CHECK (src IN (
    'qr-print', 'qr-desktop', 'email-sig', 'chat',
    'fallback-email', 'onboarding', 'campaign', 'guide'
  )),
  device text CHECK (device IN ('android', 'ios', 'desktop')),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_agent text
);

ALTER TABLE pwa_events ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: service-role only.

CREATE INDEX IF NOT EXISTS idx_pwa_events_event_created
  ON pwa_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwa_events_contact
  ON pwa_events (contact_id) WHERE contact_id IS NOT NULL;
