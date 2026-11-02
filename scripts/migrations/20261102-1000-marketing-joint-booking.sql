-- TD Marketing: the booking link WITH the owner (dev job 0b916784, 1 Nov 2026). One row per link Rocco sends: the link (only its hash is stored), who it is for, and, once the client books, the time,
-- the Zoom meeting and the Google event. The slot is HELD by an exclusion constraint on the time range (with the gap kept around each call), so two clients cannot take the same time even if they press
-- Confirm in the same second; the server re-checks both calendars after taking that hold.
-- Requires 20261018-0110-marketing-p1-db-lock.sql (marketing_teams and the lock) and 20261019-1000-marketing-leads.sql (marketing_leads).
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL OR to_regclass('public.marketing_leads') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql and 20261019-1000-marketing-leads.sql FIRST.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_joint_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  seller_user_id  uuid NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  lang            text NOT NULL DEFAULT 'it' CHECK (lang IN ('it', 'en')),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  -- open = not used yet; booking = the time is held while the booking is being finished; booked = done; cancelled = the client (or staff) cancelled; failed = the booking could not be finished (time released)
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booking', 'booked', 'cancelled', 'failed')),
  starts_at       timestamptz,
  ends_at         timestamptz,
  lock_from       timestamptz,
  lock_to         timestamptz,
  client_name     text,
  client_email    text,
  client_zone     text,
  zoom_meeting_id text,
  zoom_join_url   text,
  gcal_act_as     text,
  gcal_event_id   text,
  held_at         timestamptz,
  booked_at       timestamptz,
  cancelled_at    timestamptz,
  CHECK (status NOT IN ('booking', 'booked') OR (starts_at IS NOT NULL AND ends_at > starts_at AND lock_from IS NOT NULL AND lock_to > lock_from))
);

-- (for a table made by an earlier run of this file)
ALTER TABLE marketing_joint_links ADD COLUMN IF NOT EXISTS held_at timestamptz;

CREATE INDEX IF NOT EXISTS marketing_joint_links_lead_idx ON marketing_joint_links (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_joint_links_team_status_idx ON marketing_joint_links (team_id, status, starts_at);

-- the hold: no two calls that are being booked or are booked may overlap (the range already includes the gap kept around each call)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketing_joint_links_no_overlap') THEN
    ALTER TABLE marketing_joint_links
      ADD CONSTRAINT marketing_joint_links_no_overlap
      EXCLUDE USING gist (tstzrange(lock_from, lock_to) WITH &&) WHERE (status IN ('booking', 'booked'));
  END IF;
END $$;

ALTER TABLE marketing_joint_links ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
