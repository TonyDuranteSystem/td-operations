-- Tax Financials Self-Service — Slice 3 schema (master plan §10.3, dev task b2115fd3)
-- 1) prior_return_extracted: validated Schedule L / M-2 / K-1 data read from the
--    prior-year tax return (plan §5). Written only after internal validation passes.
-- 2) bank_categorization_rules: DB-driven categorization rules (plan §8 — replaces
--    the hardcoded regex array in lib/bank-statement-parser.ts over slices 4-5;
--    staff-editable global rules + per-client learned rules).
-- 3) bank_transactions.transaction_ref integrity (plan §9 / DB-challenge W2):
--    NULL or empty refs bypass the dedup unique index entirely — forbid them.
--    Verified 0 violating rows in production AND sandbox on 2026-06-11.

-- (1) prior-return extraction storage
ALTER TABLE public.tax_return_submissions
  ADD COLUMN IF NOT EXISTS prior_return_extracted jsonb;

COMMENT ON COLUMN public.tax_return_submissions.prior_return_extracted IS
  'Validated extraction of the prior-year return (Schedule L beginning/ending, M-2, per-partner K-1 capital + ownership %). Null until extraction passes internal validation. Master plan: tax-financials-self-service-master-plan §5.';

-- (2) categorization rules (internal table — service-role access, RLS off,
--     matching the existing bank_transactions pattern)
CREATE TABLE IF NOT EXISTS public.bank_categorization_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern text NOT NULL,
  match_type text NOT NULL DEFAULT 'contains'
    CHECK (match_type IN ('regex', 'contains', 'exact')),
  category text NOT NULL
    CHECK (category IN ('income','cogs','expense','distribution','contribution','fee','conversion','refund','uncategorized')),
  subcategory text NOT NULL DEFAULT '',
  -- NULL = global rule; set = per-client learned rule (takes precedence)
  account_id uuid REFERENCES public.accounts(id),
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','learned','seed')),
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_cat_rules_lookup
  ON public.bank_categorization_rules (active, account_id, priority);

COMMENT ON TABLE public.bank_categorization_rules IS
  'DB-driven transaction categorization rules (global + per-client learned). Read by the categorization engine (slice 5); editable without deploy per the flexible-architecture decision. Master plan §8.';

-- (3) transaction_ref integrity — refs are the dedup identity; empty/null
--     would bypass the unique index (account_id, transaction_ref,
--     transaction_date, amount). New ingestion writes deterministic row hashes.
ALTER TABLE public.bank_transactions
  ALTER COLUMN transaction_ref SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_ref_not_blank'
  ) THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_transactions_ref_not_blank CHECK (btrim(transaction_ref) <> '');
  END IF;
END $$;
