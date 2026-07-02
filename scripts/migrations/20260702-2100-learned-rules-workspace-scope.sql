-- Auto-learn Phase 4 (smart P&L categorization, 2026-07-02): workspace-scoped
-- learned rules.
--
-- A BLANK P&L workspace (no linked client) can now LEARN from staff answers:
-- its rules are scoped by workspace_id (account_id stays NULL) and die with
-- the workspace (ON DELETE CASCADE). On "Save to client" they are PROMOTED to
-- account-scoped rules — permanent per-client memory, year after year.
--
-- ⚠ DEPLOY ORDER (prod): apply THIS migration BEFORE deploying the code —
-- the engine's rule loaders now filter `.is('workspace_id', null)`, which
-- errors if the column doesn't exist yet. (Sandbox: apply-migration.js.)
--
-- Scope exclusivity: a rule is global (both NULL), account-scoped, or
-- workspace-scoped — never both. The CHECK makes the leak class impossible
-- to reintroduce at the data layer; the loader filters enforce it at reads.

ALTER TABLE public.bank_categorization_rules
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.pnl_workspaces(id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bank_cat_rules_single_scope') THEN
    ALTER TABLE public.bank_categorization_rules
      ADD CONSTRAINT chk_bank_cat_rules_single_scope CHECK (account_id IS NULL OR workspace_id IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_cat_rules_workspace
  ON public.bank_categorization_rules (workspace_id) WHERE workspace_id IS NOT NULL;

COMMENT ON COLUMN public.bank_categorization_rules.workspace_id IS
  'Workspace-scoped learned rule (blank P&L workspaces). Mutually exclusive with account_id. Promoted to account scope on Save-to-client; cascades away with the workspace.';
