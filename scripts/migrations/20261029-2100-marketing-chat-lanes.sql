-- TD Marketing: two chats inside every lead (dev job 9aec66fa; Antonio, 29 Oct 2026: "Discuss with Antonio" and "Discuss with <the setter>" for Rocco, "Discuss with Rocco" for the setter).
-- A message belongs to ONE lane: 'owners' (Antonio and Rocco) or 'setter' (Rocco and the setter). The setter never receives the owners lane, so privacy no longer depends on a filter by @-name.
-- ADDITIVE ONLY: a column with a default and two new tables. Nothing is dropped or renamed, so code that does not know about lanes keeps working on the same database.
-- Run it BEFORE the deploy of the code that uses it (that code reads the lane column). Safe to run twice.

DO $$
BEGIN
  IF to_regclass('public.marketing_lead_messages') IS NULL THEN
    RAISE EXCEPTION 'Run 20261023-2000-marketing-lead-chat.sql FIRST.';
  END IF;
END $$;

ALTER TABLE marketing_lead_messages ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'owners';
CREATE INDEX IF NOT EXISTS idx_marketing_lead_messages_lane ON marketing_lead_messages (lead_id, lane, created_at);

-- how far each person has read each lane of a lead's chat, and how far each person's device has received it (one row per lead, lane and person)
CREATE TABLE IF NOT EXISTS marketing_lead_lane_reads (
  lead_id      uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  lane         text NOT NULL,
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, lane, user_id)
);
CREATE TABLE IF NOT EXISTS marketing_lead_lane_delivery (
  lead_id      uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  lane         text NOT NULL,
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, lane, user_id)
);
ALTER TABLE marketing_lead_lane_reads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_lead_lane_delivery ENABLE ROW LEVEL SECURITY;

-- Move what already exists into its lane, exactly as the setter sees it today: a message a SETTER wrote, or one that names a setter with @, goes to the setter lane; everything else stays in the owners lane.
-- A setter = an active member (not an owner) who works leads (leads.worklist, or the 'setter' bundle) and has no pick / host / payment-link permission of her own.
WITH setters AS (
  SELECT team_id, user_id FROM marketing_team_members
  WHERE status <> 'removed' AND member_role = 'member'
    AND (coalesce(bundle, '') = 'setter' OR permissions @> ARRAY['leads.worklist'])
    AND NOT (permissions && ARRAY['leads.pick', 'calls.host', 'payment_links.create'])
    AND coalesce(bundle, '') NOT IN ('seller', 'content', 'analyst')
)
UPDATE marketing_lead_messages m SET lane = 'setter'
WHERE m.lane = 'owners'
  AND (EXISTS (SELECT 1 FROM setters s WHERE s.team_id = m.team_id AND s.user_id = m.sender_id)
       OR EXISTS (SELECT 1 FROM setters s WHERE s.team_id = m.team_id AND s.user_id = ANY (m.mentions)));

-- Everybody keeps the place they had in both lanes, so nothing turns unread by itself.
INSERT INTO marketing_lead_lane_reads (lead_id, lane, team_id, user_id, last_read_at)
SELECT r.lead_id, l.lane, r.team_id, r.user_id, r.last_read_at FROM marketing_lead_chat_reads r JOIN marketing_leads ld ON ld.id = r.lead_id JOIN marketing_teams tm ON tm.id = r.team_id CROSS JOIN (VALUES ('owners'), ('setter')) AS l(lane)
ON CONFLICT DO NOTHING;
INSERT INTO marketing_lead_lane_delivery (lead_id, lane, team_id, user_id, delivered_at)
SELECT d.lead_id, l.lane, d.team_id, d.user_id, d.delivered_at FROM marketing_lead_chat_delivery d JOIN marketing_leads ld ON ld.id = d.lead_id JOIN marketing_teams tm ON tm.id = d.team_id CROSS JOIN (VALUES ('owners'), ('setter')) AS l(lane)
ON CONFLICT DO NOTHING;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
