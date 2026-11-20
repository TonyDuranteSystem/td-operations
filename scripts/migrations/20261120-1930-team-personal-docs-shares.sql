-- Team Powers, step 7 — an owner shares THEIR OWN personal documents with one team login (dev job e59dd470).
-- One row per (team login, owner contact). The row belongs to the OWNER who made it: an owner can only switch on or off their own papers.
-- No foreign keys on purpose (same as portal_team_events): deleting a company, a person or a login must never be blocked by, or silently erase, this list.
-- Only the app server (service role) touches it: RLS on, no policy, no privileges for anon / logged-in tokens.
-- Safe to run twice. Undo: 20261120-1930-team-personal-docs-shares.UNDO.sql.
-- NO new CHECK constraint and NO change to the event list: the share is recorded as a 'powers_changed' line in portal_team_events.

CREATE TABLE IF NOT EXISTS portal_team_document_shares (
  team_member_id   uuid        NOT NULL,
  owner_contact_id uuid        NOT NULL,
  account_id       uuid        NOT NULL,
  notice_version   text,
  granted_ip       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_member_id, owner_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_ptds_owner ON portal_team_document_shares (owner_contact_id);
CREATE INDEX IF NOT EXISTS idx_ptds_account ON portal_team_document_shares (account_id);

ALTER TABLE public.portal_team_document_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_team_document_shares FROM anon, authenticated;

COMMENT ON TABLE portal_team_document_shares IS
  'Team Powers step 7: owner_contact_id has shared their OWN personal documents with team login team_member_id. Read only by the app server. No foreign keys on purpose.';

-- Standing lock for every new table (see tests/unit/migrations-marketing-lock.test.ts).
SELECT public.marketing_lock_all_tables();
