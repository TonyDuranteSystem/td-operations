-- Categorization engine Slice 5a (master plan §8/§9, dev task b2115fd3):
-- 1) direction gating on rules — "Stripe" must categorize money FROM Stripe
--    as revenue without also catching refunds paid TO Stripe.
-- 2) Conservative seed rules built ONLY from bank vocabulary verified in real
--    client exports (2026-06-11): Slash transaction types, Mercury's category
--    column, Stripe payouts. Everything else stays uncategorized for the AI
--    assist / human review — a wrong seed silently corrupts P&Ls.

ALTER TABLE public.bank_categorization_rules
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'any'
  CHECK (direction IN ('in', 'out', 'any'));

-- Seeds are idempotent: keyed on (pattern, direction, account_id IS NULL).
INSERT INTO public.bank_categorization_rules
  (pattern, match_type, category, subcategory, account_id, priority, active, source, direction, notes, created_by)
SELECT v.pattern, v.match_type, v.category, v.subcategory, NULL, v.priority, true, 'seed', v.direction, v.notes, 'migration-20260611-1700'
FROM (VALUES
  -- Slash transaction types (verified real export). The parser composes the
  -- description as "Type | Description".
  ('Inbound Ach Transfer',        'contains', 'income',       'revenue',              100, 'in',  'Slash: incoming ACH from third parties'),
  ('Cashback Redemption',         'contains', 'income',       'other_income',         100, 'in',  'Slash: card cashback'),
  ('Foreign Transaction Fees',    'contains', 'fee',          'bank_fee',             100, 'out', 'Slash: FX fee lines'),
  ('Slash subscription',          'contains', 'fee',          'bank_fee',             100, 'out', 'Slash: platform subscription'),
  ('Daily Credit Card Payment',   'contains', 'expense',      'card_payment',         110, 'out', 'Slash: aggregated daily card-spend repayment (cash basis)'),
  ('Deposit User Funds',          'contains', 'contribution', 'capital_contribution', 110, 'in',  'Slash: owner deposits own funds; transfer-matcher re-pairs if the source account is also uploaded'),
  -- Mercury category column (parser embeds it as "[Category]")
  ('[ProfessionalServices]',      'contains', 'expense',      'professional_services', 100, 'out', 'Mercury category: professional services'),
  -- Payment processors: payouts are revenue (inflows only)
  ('STRIPE',                      'contains', 'income',       'revenue',              120, 'in',  'Stripe payouts = sales revenue')
) AS v(pattern, match_type, category, subcategory, priority, direction, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bank_categorization_rules r
  WHERE r.pattern = v.pattern AND r.direction = v.direction AND r.account_id IS NULL
);
