-- Advisory AI review hints on bank_transactions (#2, 2026-06-18).
-- The AI categorization pass already reasons business-vs-personal but today it
-- DISCARDS everything below high-confidence. These two nullable columns let the
-- pass RECORD, for the still-uncategorized rows the client will review, a
-- best-guess lean (business/personal/unsure) + an accountant bucket slug (from
-- the flexible `expense_categories` catalog). They are ADVISORY ONLY — they
-- never change `category`/`subcategory`; the client confirms, and the default
-- (uncategorized outflow → business expense) still governs the P&L until then.
-- The review screen reads these to pre-sort by bucket and pre-tag each merchant.

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS ai_lean text,
  ADD COLUMN IF NOT EXISTS ai_bucket text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_ai_lean_check') THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_transactions_ai_lean_check
      CHECK (ai_lean IS NULL OR ai_lean IN ('business','personal','unsure'));
  END IF;
END $$;

COMMENT ON COLUMN public.bank_transactions.ai_lean IS
  'Advisory AI guess for the tax-financials review: business | personal | unsure. Never a tax category — the client confirms. #2 2026-06-18.';
COMMENT ON COLUMN public.bank_transactions.ai_bucket IS
  'Advisory AI accountant-bucket slug from the expense_categories catalog (or other). Groups the client review only. #2 2026-06-18.';
