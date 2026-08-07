-- partner_access_log — audit trail of everything a partner login touches
-- (dev job 5f534ed9, Antonio 2026-08-07). Staff-viewable; append-only.
--
--  * One row per partner page load / data API call / file-URL signing.
--  * File signings from the private wizard-uploads bucket (passports, SSNs)
--    get their OWN explicit rows (surface='file_signed', resource=storage
--    path) — signing IS the download grant, so it is the loggable event.
--  * Deliberately NOT logged: the unread-badge poll (fires continuously,
--    carries no client data) — recorded on the job card.
--  * Service-role writes only: RLS on, zero policies.

CREATE TABLE IF NOT EXISTS partner_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  partner_id uuid NOT NULL,
  surface text NOT NULL,
  method text,
  path text,
  resource text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  user_agent text
);

ALTER TABLE partner_access_log ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: service-role only.

CREATE INDEX IF NOT EXISTS idx_partner_access_log_partner_time
  ON partner_access_log (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_access_log_surface
  ON partner_access_log (surface, created_at DESC);
