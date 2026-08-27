-- Multi-option offers (dev job 3c1bb5fa). A client can be offered several
-- complete state/entity-type/price/renewal combinations on ONE offer and pick
-- one. Additive + nullable: an offer with no packages behaves exactly as
-- today (packages IS NULL is the ordinary case, not a migrated default).
--
-- Design, reviewed by senior-engineer + ai-architect + bug-hunter (two
-- rounds): the picked package's data gets WRITTEN THROUGH onto the offer's
-- existing top-level columns (entity_type, formation_state, services,
-- cost_summary, currency, bank_details, recurring_costs, installment_currency)
-- at lock time — these three new columns exist ONLY to hold the authored
-- candidates and record which one was picked. Every existing downstream
-- consumer (the amount engine, the signing webhook, referral commission,
-- checkout, the contract page) needs ZERO changes because by the time any of
-- them run, a locked offer looks exactly like an ordinary single-option offer.
--
-- package_locked_at is the concurrency guard: the pick-lock write MUST be
-- `UPDATE offers SET ... WHERE token = $1 AND package_locked_at IS NULL`,
-- checked by returned row count (not just absence of a DB error) — see
-- app/api/offers/release-commission/route.ts for the correct existing
-- pattern in this codebase; do NOT copy the row-count-blind version used in
-- lib/operations/banking-review.ts / tax-review.ts / closure-review.ts.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS packages jsonb;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS selected_package_key text;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS package_locked_at timestamptz;

COMMENT ON COLUMN offers.packages IS
  'Optional array of selectable option bundles (multi-option offers). Each element: {key, label, currency, entity_type, formation_state, services, cost_summary, recurring_costs, installment_currency}. NULL = ordinary single-option offer, unchanged behavior. Validated in code (lib/operations/offers.ts) — every package must carry a price, currency, entity_type, formation_state, and both renewal installment amounts before the offer can be created.';
COMMENT ON COLUMN offers.selected_package_key IS
  'The `key` of the package the client picked, set atomically at lock time by the same write that copies its data onto entity_type/formation_state/services/cost_summary/currency/bank_details/recurring_costs/installment_currency. NULL until picked.';
COMMENT ON COLUMN offers.package_locked_at IS
  'When the client''s package pick became final and irreversible. NULL = not yet picked (or not a multi-option offer). The pick-lock write is a compare-and-swap on this column being NULL — see lib/offers/package-pick.ts.';
