-- Standalone P&L tool — isolated workspace fix (MMLLC). M1: workspace tables.
--
-- WHY: today `/tools/pnl` runs the tax-financials review directly against a real
-- client's account_id+tax_year — it preloads their stored data AND writes staff
-- test uploads into their REAL bank_transactions (a data-safety bug). These three
-- tables give a staff run its own ISOLATED storage: a workspace's transactions,
-- members, and prior-return live here and NEVER touch a real client's books until
-- an explicit, audited "Save to client".
--
-- DESIGN:
--   * pnl_workspace_transactions MIRRORS the exact columns the financials engine
--     reads from bank_transactions (verified against live sandbox schema), so the
--     PURE engine (buildFinancialDraft / gates / recategorize core) runs unchanged
--     against a workspace. Dedup uniqueness mirrors bank_transactions' 4-col index
--     but scoped by workspace_id instead of account_id.
--   * Members are structured (not just JSON) and support ENTITY members (a company
--     owning the LLC), reusing the existing member-form vocabulary in `details`.
--   * NOT a workspace_id column on bank_transactions — that would leak scratch rows
--     into the bank-feed matcher / /owner / every other reader. Separate tables =
--     isolation by construction.
--
-- RLS: ON with NO policy — same convention as td_comm_enrollments / comm_conversations.
-- The browser never queries these; all reads/writes go through the service role
-- (supabaseAdmin) after an isDashboardUser auth check in app/api/tools/pnl/*.
-- Workspaces (and any forked client PII they hold) are staff-only.

-- 1) Workspaces --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pnl_workspaces (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by            text,                                   -- staff user id/email (dashboard user)
  label                 text,                                   -- free-text name for the run
  linked_account_id     uuid REFERENCES accounts(id) ON DELETE SET NULL, -- set when forked from a client; NULL for a blank run
  tax_year              integer NOT NULL,
  entity_type           text NOT NULL DEFAULT 'MMLLC',          -- selects the accounting engine from the registry; only MMLLC registered today
  company_name          text,                                   -- entity name (intake)
  ein                   text,                                   -- entity EIN (intake)
  prior_return_snapshot jsonb,                                  -- workspace-local prior-return record (never a real tax_return_submissions row)
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'archived')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pnl_workspaces_created_by
  ON pnl_workspaces (created_by);
CREATE INDEX IF NOT EXISTS idx_pnl_workspaces_linked_account
  ON pnl_workspaces (linked_account_id);
CREATE INDEX IF NOT EXISTS idx_pnl_workspaces_status
  ON pnl_workspaces (status);
CREATE INDEX IF NOT EXISTS idx_pnl_workspaces_created
  ON pnl_workspaces (created_at DESC);

ALTER TABLE pnl_workspaces ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE pnl_workspaces IS
  'Standalone P&L tool: an isolated staff workspace (blank or forked from a client). Holds the entity identity + tax year + prior-return snapshot. RLS ON, no policy — service-role only after isDashboardUser auth in app/api/tools/pnl/*.';

-- 2) Workspace members (supports entity members) -----------------------------
CREATE TABLE IF NOT EXISTS pnl_workspace_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES pnl_workspaces(id) ON DELETE CASCADE,
  member_type   text NOT NULL CHECK (member_type IN ('individual', 'company')),
  display_name  text NOT NULL,                                  -- person full name OR company legal name
  ownership_pct numeric,                                        -- validated to total 100 in-app (K-1 allocation)
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,             -- individual: citizenship/residence/address/ITIN/W-8BEN; company: EIN/representative
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pnl_workspace_members_workspace
  ON pnl_workspace_members (workspace_id);

ALTER TABLE pnl_workspace_members ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE pnl_workspace_members IS
  'Standalone P&L tool: structured member roster for a workspace. member_type individual|company (entity members supported); display_name + ownership_pct feed resolveOwnership; details jsonb holds the full member-form data. RLS ON, no policy — service-role only.';

-- 3) Workspace transactions (mirror of engine-read bank_transactions columns) --
CREATE TABLE IF NOT EXISTS pnl_workspace_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES pnl_workspaces(id) ON DELETE CASCADE,
  tax_year          integer NOT NULL,
  transaction_date  date NOT NULL,
  description       text,
  category          text,
  subcategory       text,
  counterparty      text,
  amount            numeric NOT NULL,
  currency          text DEFAULT 'EUR',
  balance_after     numeric,
  bank_name         text,
  account_type      text,
  transaction_ref   text NOT NULL,
  source_file_id    text,
  is_related_party  boolean DEFAULT false,
  notes             text,
  ai_lean           text,
  ai_bucket         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Dedup: mirrors bank_transactions' 4-col unique index, scoped by workspace_id.
  CONSTRAINT pnl_workspace_transactions_dedup
    UNIQUE (workspace_id, transaction_ref, transaction_date, amount)
);

CREATE INDEX IF NOT EXISTS idx_pnl_workspace_transactions_workspace_year
  ON pnl_workspace_transactions (workspace_id, tax_year);

ALTER TABLE pnl_workspace_transactions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE pnl_workspace_transactions IS
  'Standalone P&L tool: a workspace''s isolated transactions — same columns the financials engine reads from bank_transactions, scoped by workspace_id (never account_id). Dedup UNIQUE(workspace_id, transaction_ref, transaction_date, amount). RLS ON, no policy — service-role only.';
