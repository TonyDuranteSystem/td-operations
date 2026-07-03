-- Smart Categorization v2, Phase 0.2 (2026-07-03).
-- Two defects found by the adversarial review of the learning loop:
--   1. findRule→insertRule is non-atomic and there is NO unique constraint on
--      (scope, pattern, direction) — two staff answering the same merchant
--      group simultaneously insert duplicate learned rules.
--   2. An 'any'-direction rule and an 'in'/'out' rule for the SAME pattern can
--      coexist at equal priority with no deterministic winner (applyRules
--      sorts by priority only) — a nondeterministic result on a tax category.
-- Code companion (same push): upsertLearnedMerchantRules now deactivates
-- conflicting-direction rows on upsert. This migration adds the DB backstop.
--
-- Pre-clean: deactivate older duplicates (keep the newest per key) so the
-- partial unique indexes can build. Nothing is deleted — audit trail intact.

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY coalesce(account_id::text, 'W:' || workspace_id::text, 'G'), pattern, direction
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
  ) AS rn
  FROM public.bank_categorization_rules
  WHERE active = true
)
UPDATE public.bank_categorization_rules r
SET active = false,
    notes = coalesce(r.notes, '') || ' [deactivated 2026-07-03: duplicate (scope,pattern,direction), superseded by newest]'
FROM ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

-- Uniqueness among ACTIVE rules per scope (deactivated history rows exempt).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_cat_rules_account_pattern_dir
  ON public.bank_categorization_rules (account_id, pattern, direction)
  WHERE account_id IS NOT NULL AND active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_cat_rules_workspace_pattern_dir
  ON public.bank_categorization_rules (workspace_id, pattern, direction)
  WHERE workspace_id IS NOT NULL AND active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_cat_rules_global_pattern_dir
  ON public.bank_categorization_rules (pattern, direction)
  WHERE account_id IS NULL AND workspace_id IS NULL AND active = true;
