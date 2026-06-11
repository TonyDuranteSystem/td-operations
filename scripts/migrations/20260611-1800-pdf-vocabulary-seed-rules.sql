-- Slice 5b benchmark finding (2026-06-11, Dynamiq 4,807-tx set): the Slice 5a
-- seeds cover CSV-export vocabulary, but transactions ingested from PDF
-- statements (AI-extracted) carry different bank vocabulary — the 8 CSV seeds
-- matched ZERO of Dynamiq's 3,491 uncategorized rows. These two rules cover
-- the dominant generic (non-merchant) PDF patterns verified in that live set:
--   "Intl. Transaction Fee"  — Mercury FX fee lines (~906 txs in the benchmark)
--   "Corporate Card -"       — Relay aggregated card-spend lines (~550 txs)
-- Merchant-name spends (Uber, Shopify, …) stay with the AI-assist pass —
-- merchant rules are unbounded and belong per-client, not as global seeds.

INSERT INTO public.bank_categorization_rules
  (pattern, match_type, category, subcategory, account_id, priority, active, source, direction, notes, created_by)
SELECT v.pattern, v.match_type, v.category, v.subcategory, NULL, v.priority, true, 'seed', v.direction, v.notes, 'migration-20260611-1800'
FROM (VALUES
  ('Intl. Transaction Fee', 'contains', 'fee',     'bank_fee',     100, 'out', 'Mercury PDF: international transaction fee lines'),
  ('Corporate Card -',      'contains', 'expense', 'card_payment', 110, 'out', 'Relay PDF: aggregated corporate-card spend lines (cash basis)')
) AS v(pattern, match_type, category, subcategory, priority, direction, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bank_categorization_rules r
  WHERE r.pattern = v.pattern AND r.direction = v.direction AND r.account_id IS NULL
);
