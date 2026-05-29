-- Portal Team Access — Phase 1 foundation
-- Design: sysdoc 'portal-team-access-design' (Option B — independent teammate identity).
--
-- Creates portal_team_members: employees an account-admin invites to ONE company's
-- portal. Teammates are NOT contacts and NOT in account_contacts (so billing/ops
-- flows never target them). Capabilities are owner-chosen per-section flags (JSONB),
-- enforced server-side, default-deny. Auth identity lives in auth.users with
-- app_metadata.role='client' + kind='team_member' markers.
--
-- Also adds accounts.portal_admin_contact_id: the editable "main person" who may
-- manage the team (auto-resolved at app level: SMLLC owner / MMLLC SS-4 signer,
-- overridable here).

-- 1. Team members table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_team_members (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  username               text NOT NULL,
  display_name           text NOT NULL,
  email                  text,                         -- optional; enables notifications + self password reset
  capabilities           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {documents,invoices_billing,chat,company_services,bank_applications,...} booleans; empty = deny
  created_by             uuid REFERENCES contacts(id) ON DELETE SET NULL,  -- the account-admin contact who invited
  disclaimer_accepted_at timestamptz,
  disclaimer_accepted_by uuid REFERENCES contacts(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'active',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ptm_status CHECK (status IN ('active','revoked'))
);

-- Username is the login handle — globally unique, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_team_members_username
  ON portal_team_members (lower(username));
-- One grant row per auth login.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_team_members_auth_user
  ON portal_team_members (auth_user_id);
CREATE INDEX IF NOT EXISTS idx_portal_team_members_account
  ON portal_team_members (account_id);

-- Sensitive table: only the service role (app server) ever reads/writes it.
-- Enable RLS with NO policy → denies anon/authenticated direct access; service
-- role bypasses RLS. Consistent with portal isolation being enforced in app code.
ALTER TABLE portal_team_members ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE portal_team_members IS
  'Portal Team Access (Option B): employees granted scoped portal access to ONE company. Not contacts, not in account_contacts. Capabilities are server-enforced per-section flags. See sysdoc portal-team-access-design.';

-- 2. Account admin pointer ("main person" who manages the team) ---------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS portal_admin_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN accounts.portal_admin_contact_id IS
  'The contact who can manage portal team members for this account. Auto-resolved (SMLLC owner / MMLLC SS-4 signer) and overridable via CRM. NULL = resolve at read time.';
