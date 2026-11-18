-- Team Powers, step 2 — the invisible foundation (dev job e59dd470).
-- (1) six new columns on portal_team_members: the notice the owner accepted, and who switched the person off.
-- (2) portal_team_events: a record of every team action that nobody can edit or delete.
-- No status value is added on purpose: a switched-off person is status 'revoked' WITH switched_off_at set, so every
-- reader that only trusts status = 'active' (login, chat email, phone alerts) keeps refusing them with no code change.
-- A person removed for good is 'revoked' with switched_off_at NULL and can never be switched back on.
-- Safe to run twice. Undo: 20261117-2300-team-foundation.UNDO.sql.

-- 1. New columns -------------------------------------------------------------
ALTER TABLE portal_team_members
  ADD COLUMN IF NOT EXISTS notice_version      text,
  ADD COLUMN IF NOT EXISTS notice_accepted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS notice_accepted_ip  text,
  ADD COLUMN IF NOT EXISTS switched_off_by     text,
  ADD COLUMN IF NOT EXISTS switched_off_at     timestamptz,
  ADD COLUMN IF NOT EXISTS switched_off_reason text;

-- A switch-off is all three fields together or none. A SHAPE check (not a value list), so nothing else has to register it.
ALTER TABLE portal_team_members DROP CONSTRAINT IF EXISTS ptm_switched_off_shape;
ALTER TABLE portal_team_members
  ADD CONSTRAINT ptm_switched_off_shape CHECK (
    (switched_off_at IS NULL AND switched_off_by IS NULL AND switched_off_reason IS NULL)
    OR (switched_off_at IS NOT NULL AND switched_off_by IS NOT NULL AND switched_off_by ~ '^(owner|td)$')
  );

COMMENT ON COLUMN portal_team_members.switched_off_at IS
  'Set = the person is SWITCHED OFF (status revoked, login banned) and may be switched back on. NULL on a revoked row = removed for good.';
COMMENT ON COLUMN portal_team_members.switched_off_by IS
  'owner or td. If td switched the person off, the owner cannot switch them back on.';

-- 2. The event record -----------------------------------------------------------
-- NO foreign keys on purpose: deleting a company or a person must never erase or block this history.
CREATE TABLE IF NOT EXISTS portal_team_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id    uuid NOT NULL,
  account_id        uuid NOT NULL,
  event             text NOT NULL,
  actor_kind        text NOT NULL,
  actor_contact_id  uuid,
  actor_staff_email text,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip                text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_team_events_member  ON portal_team_events (team_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_team_events_account ON portal_team_events (account_id, created_at DESC);

-- Only the app server (service role) touches it: RLS on, no policy, and no privileges for anon / logged-in tokens.
ALTER TABLE public.portal_team_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_team_events FROM anon, authenticated;

-- The allowed event names live HERE (not in a CHECK list) so the shared sandbox's constraint checks stay untouched.
-- A unit test keeps this list identical to the TypeScript list in lib/portal/team/events.ts.
CREATE OR REPLACE FUNCTION public.trg_portal_team_events_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.event NOT IN ('added', 'powers_changed', 'removed', 'switched_off', 'switched_on', 'password_reset', 'notice_accepted', 'migrated') THEN
      RAISE EXCEPTION 'portal_team_events: unknown event %', NEW.event;
    END IF;
    IF NEW.actor_kind NOT IN ('owner', 'td', 'system') THEN
      RAISE EXCEPTION 'portal_team_events: unknown actor_kind %', NEW.actor_kind;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'portal_team_events is append-only: % is refused', TG_OP;
END $$;

CREATE OR REPLACE FUNCTION public.trg_portal_team_events_no_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'portal_team_events is append-only: TRUNCATE is refused';
END $$;

DROP TRIGGER IF EXISTS trg_portal_team_events_guard ON portal_team_events;
CREATE TRIGGER trg_portal_team_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON portal_team_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_portal_team_events_guard();

DROP TRIGGER IF EXISTS trg_portal_team_events_no_truncate ON portal_team_events;
CREATE TRIGGER trg_portal_team_events_no_truncate
  BEFORE TRUNCATE ON portal_team_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_portal_team_events_no_truncate();

REVOKE ALL ON FUNCTION public.trg_portal_team_events_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_portal_team_events_no_truncate() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE portal_team_events IS
  'Team Powers: one row per team action (added, powers changed, removed, switched off/on, password reset, notice accepted). Append-only (trigger refuses UPDATE/DELETE/TRUNCATE). No foreign keys on purpose.';

-- Standing lock for every new table (see tests/unit/migrations-marketing-lock.test.ts).
SELECT public.marketing_lock_all_tables();
