-- TD Marketing — lead intake from Meta (dev job 9aec66fa, Slice 1). SANDBOX FIRST; production only on Antonio's go, pasted to him in chat.
-- Additive: three new tables, nothing existing is touched. Server only (RLS on, no policy): the app reads and writes through the server.
--   marketing_leadgen_events  one row per Meta "new lead" notification (ids only) — the durable inbox: a lead is never lost if the fetch fails; retried by cron
--   marketing_leads           the lead itself, with EVERY form answer kept exactly as received, plus the ad/campaign/form it came from
--   marketing_lead_events     append-only timeline of what happened to a lead
-- Requires 20261017-1900 and 20261018-0110 (marketing_teams, marketing_block_change). Undo: 20261019-1000-marketing-leads.UNDO.sql.
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL OR to_regprocedure('public.marketing_block_change()') IS NULL THEN
    RAISE EXCEPTION 'Run 20261017-1900-marketing-p0-settings.sql FIRST: marketing_teams / marketing_block_change are missing.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            uuid REFERENCES marketing_teams(id) ON DELETE RESTRICT,   -- NULL = not assigned to a team yet (Antonio sees it and assigns)
  leadgen_id         text NOT NULL UNIQUE,                                     -- Meta's id: a duplicate delivery can never create a second lead
  source             text NOT NULL DEFAULT 'meta_lead_ad',
  page_id            text,
  form_id            text,
  ad_id              text,
  ad_name            text,
  adset_id           text,
  adset_name         text,
  campaign_id        text,
  campaign_name      text,
  platform           text,
  is_organic         boolean,
  meta_created_time  timestamptz,
  full_name          text,
  email              text,
  phone              text,
  country            text,
  city               text,
  answers            jsonb NOT NULL DEFAULT '[]'::jsonb,                       -- [{name, values[]}] exactly as Meta sent them
  raw                jsonb,                                                    -- the whole Graph payload, for anything we did not map
  status             text NOT NULL DEFAULT 'new' CHECK (length(btrim(status)) > 0),  -- a pipeline stage key (a setting, not fixed here)
  existing_client    jsonb,                                                    -- {contact_ids:[...], matched_on:[...]} when the person looks like a TD client
  received_at        timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_team_received ON marketing_leads (team_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_email ON marketing_leads (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing_leadgen_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leadgen_id        text NOT NULL UNIQUE,
  page_id           text,
  form_id           text,
  ad_id             text,
  adgroup_id        text,
  meta_created_time timestamptz,
  source            text NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook', 'reconcile')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'gave_up')),
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  lead_id           uuid REFERENCES marketing_leads(id) ON DELETE RESTRICT,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_leadgen_events_open ON marketing_leadgen_events (status, updated_at) WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS marketing_lead_events (
  id         bigserial PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE RESTRICT,
  kind       text NOT NULL CHECK (length(btrim(kind)) > 0),                    -- received | status_changed | note | ...
  actor      text NOT NULL DEFAULT 'system',
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_lead_events_lead ON marketing_lead_events (lead_id, created_at);
DROP TRIGGER IF EXISTS trg_marketing_lead_events_append_only ON marketing_lead_events;
CREATE TRIGGER trg_marketing_lead_events_append_only BEFORE UPDATE OR DELETE ON marketing_lead_events
  FOR EACH ROW EXECUTE FUNCTION marketing_block_change();

ALTER TABLE marketing_leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_leadgen_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_lead_events    ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
