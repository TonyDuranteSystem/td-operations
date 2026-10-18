-- TD Marketing P0 (dev job 9aec66fa): the settings storage. SANDBOX FIRST. Additive: three new tables, nothing existing touched.
--   marketing_teams            one row per seller team; stays 'draft' (nobody can log in) until an admin activates it
--   marketing_settings         every rule as a value (key + optional team), edited by admin only
--   marketing_settings_history append-only: who changed which setting from what to what
--   marketing_commission_terms append-only: new rate applies to FUTURE sales, past sales keep the terms they were sold under
-- Service role only (RLS on, no policies): the app reads and writes through the server, never from the browser.

CREATE TABLE IF NOT EXISTS marketing_teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  owner_user_id uuid,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL CHECK (length(btrim(key)) > 0),
  team_id    uuid REFERENCES marketing_teams(id) ON DELETE CASCADE,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One value per (key, team); team_id NULL = a program-wide value.
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_settings_key_team
  ON marketing_settings (key, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS marketing_settings_history (
  id         bigserial PRIMARY KEY,
  key        text NOT NULL,
  team_id    uuid,
  old_value  jsonb,
  new_value  jsonb,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_commission_terms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  person_ref       text NOT NULL DEFAULT 'team',            -- 'team' = everyone on the team, else a user id
  kind             text NOT NULL CHECK (length(btrim(kind)) > 0),  -- 'strategic_call', 'upsell', ... (a catalog value, not fixed here)
  seller_pct       numeric(5,2) NOT NULL CHECK (seller_pct >= 0 AND seller_pct <= 100),
  td_pct           numeric(5,2) NOT NULL CHECK (td_pct >= 0 AND td_pct <= 100),
  basis            text NOT NULL DEFAULT 'amount_paid' CHECK (basis IN ('amount_paid', 'net_of_fees')),
  payee_account_id uuid,                                      -- the seller's own company in the CRM (no FK: ids differ per environment)
  effective_from   timestamptz NOT NULL DEFAULT now(),
  set_by           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (seller_pct + td_pct = 100)
);
CREATE INDEX IF NOT EXISTS idx_marketing_terms_lookup
  ON marketing_commission_terms (team_id, kind, person_ref, effective_from DESC);

-- Append-only guards.
CREATE OR REPLACE FUNCTION marketing_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: add a new row instead of changing or deleting one', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS trg_marketing_terms_append_only ON marketing_commission_terms;
CREATE TRIGGER trg_marketing_terms_append_only BEFORE UPDATE OR DELETE ON marketing_commission_terms
  FOR EACH ROW EXECUTE FUNCTION marketing_block_change();
DROP TRIGGER IF EXISTS trg_marketing_history_append_only ON marketing_settings_history;
CREATE TRIGGER trg_marketing_history_append_only BEFORE UPDATE OR DELETE ON marketing_settings_history
  FOR EACH ROW EXECUTE FUNCTION marketing_block_change();

-- Every settings change writes its own history row, so no code path can forget to.
CREATE OR REPLACE FUNCTION marketing_settings_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO marketing_settings_history (key, team_id, old_value, new_value, changed_by) VALUES (NEW.key, NEW.team_id, NULL, NEW.value, NEW.updated_by);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.value IS DISTINCT FROM OLD.value THEN
      INSERT INTO marketing_settings_history (key, team_id, old_value, new_value, changed_by) VALUES (NEW.key, NEW.team_id, OLD.value, NEW.value, NEW.updated_by);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marketing_settings_log ON marketing_settings;
CREATE TRIGGER trg_marketing_settings_log AFTER INSERT OR UPDATE ON marketing_settings
  FOR EACH ROW EXECUTE FUNCTION marketing_settings_log();

ALTER TABLE marketing_teams            ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_commission_terms ENABLE ROW LEVEL SECURITY;
