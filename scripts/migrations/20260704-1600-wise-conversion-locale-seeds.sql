-- Wise conversion phrasings, remaining locales (2026-07-04).
-- The engine's built-ins already book EN "Converted" / IT-FR "Convertit" as
-- conversion INSTANTLY — but Wise exports in the account holder's language,
-- and Spanish-language accounts (Dynamiq: 169 rows) sailed past into the
-- human review as absurd "Se han convertido 417,02 USD a 400,00 EUR →
-- business income?" questions. Dual-review framing (Phase 3R cond. 14):
-- Wise's export phrasings are the CLOSED FORMAT VOCABULARY of one parsed
-- product — like Chase's ACCT_XFER token — not per-language business logic.
-- Conversion is the ZERO-P&L-IMPACT class (excluded from totals entirely),
-- so these seeds carry none of the auto-expense risk that kept the Spanish
-- "sent money" phrasing OUT of the seeds (LOREA lesson: transfers to related
-- entities must stay human/card decisions).
-- Idempotent (pattern of 20260702-2000). Rollback = active=false, no deploy.

INSERT INTO bank_categorization_rules (pattern, match_type, category, subcategory, direction, priority, active, source, notes, created_by)
SELECT v.pattern, 'contains', 'conversion', 'currency_conversion', 'any', 40, true, 'seed',
       'Wise conversion phrasing (' || v.locale || ') — format vocabulary, zero-P&L class. 2026-07-04.',
       'claude'
FROM (VALUES
  ('Se han convertido', 'es'),
  ('Se ha convertido',  'es'),
  ('Foram convertidos', 'pt'),
  ('Foi convertido',    'pt'),
  ('wurden umgerechnet','de'),
  ('wurde umgerechnet', 'de'),
  ('umgetauscht in',    'de')
) AS v(pattern, locale)
WHERE NOT EXISTS (
  SELECT 1 FROM bank_categorization_rules r
  WHERE r.pattern = v.pattern AND r.account_id IS NULL AND r.workspace_id IS NULL AND r.source = 'seed'
);
