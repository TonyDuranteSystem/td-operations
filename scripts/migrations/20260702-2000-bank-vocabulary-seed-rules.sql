-- Bank-vocabulary seed rules (smart P&L categorization Phase 2, 2026-07-02).
-- Origin: B&P International $594k incident — the generic CSV parser already
-- folds the bank's own transaction-type tokens into the description
-- ("Online Transfer to MMA ...2131 … | DEBIT | ACCT_XFER"), but no rule matched
-- them, so an entire Chase account fell to 'uncategorized'.
--
-- Conservative by design (a wrong seed silently corrupts P&Ls):
--   * ONLY vocabulary verified against the real B&P Chase export (2026-07-02).
--   * NO income seeds for incoming wires (WIRE_INCOMING / BOOK TRANSFER
--     CREDIT): an incoming wire can be the client's own money coming back —
--     the own-entity pass + AI decide those.
--   * NO Zelle/QUICKPAY seed: stays flagged for human review (Antonio).
--   * NO DEPOSIT_RETURN seed (deviation from the plan, caught in pre-mortem):
--     booking the return as `refund` while its matching CHECK_DEPOSIT leg
--     stays uncategorized would inflate expenses by the returned amount.
--     Both legs stay flagged so they cancel visibly under review.
--   * Per-client vocabulary (e.g. "ORIG CO NAME:…ETHOS" → income for B&P) is
--     NOT seeded here — account UUIDs differ per environment; add per-account
--     rules operationally via the rules UI / learned rules.
--
-- Idempotent: keyed on (pattern, direction, account_id IS NULL) like
-- 20260611-1700. Rollback = UPDATE … SET active = false (no deploy).

INSERT INTO public.bank_categorization_rules
  (pattern, match_type, category, subcategory, account_id, priority, active, source, direction, notes, created_by)
SELECT v.pattern, v.match_type, v.category, v.subcategory, NULL, v.priority, true, 'seed', v.direction, v.notes, 'migration-20260702-2000'
FROM (VALUES
  -- Chase transaction-type tokens (folded into the description by the generic
  -- parser's Type/Details columns — verified real B&P export).
  ('ACCT_XFER', 'contains', 'conversion', 'internal_transfer', 90, 'any',
   'Chase type code: transfer between the customer''s own Chase accounts — never revenue/expense'),
  -- Online Transfer lines carry the transaction#: token on every observed
  -- internal row — required here so an (unobserved) external "online transfer"
  -- phrasing cannot be swallowed as internal.
  ('Online Transfer (to|from) (MMA|CHK|SAV)\s?\.\.\..*transaction#', 'regex', 'conversion', 'internal_transfer', 95, 'any',
   'Chase online transfer between own checking/savings sub-accounts (transaction# guard)'),
  ('FEE_TRANSACTION', 'contains', 'fee', 'bank_fee', 100, 'out',
   'Chase type code: bank service/FX-adjustment fee lines'),
  ('SERVICE CHARGES FOR THE MONTH', 'contains', 'fee', 'bank_fee', 100, 'out',
   'Chase monthly account service charge'),
  -- Savings/MMA interest — taxable interest income (verified: MMA "INTEREST
  -- PAYMENT" lines). Direction-gated to inflows.
  ('INTEREST PAYMENT', 'contains', 'income', 'interest_income', 100, 'in',
   'Bank interest credited on savings/money-market accounts')
) AS v(pattern, match_type, category, subcategory, priority, direction, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bank_categorization_rules r
  WHERE r.pattern = v.pattern AND r.direction = v.direction AND r.account_id IS NULL
);
