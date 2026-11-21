-- A payer's company type is a free label, not a fixed list (dev job 709ac868, Antonio 2026-11-20: "a type of company doesn't need any kind of list").
--
-- WHY: PRODUCTION's billing_entities has a CHECK that only accepts entity_type = SRL, SRLS, SPA, ditta_individuale, persona_fisica, GmbH,
-- Ltd or other. The offer-signing code wrote the label "company" for a typed "Invoice to" payer, so every such save was refused and the
-- client signed with NO invoice. The sandbox never had the CHECK, so every sandbox run passed. Nothing reads a payer's type (the invoice
-- prints name, address and VAT), so the fixed list protects nothing and is only a trap for whoever writes a new label.
--
-- WHAT THIS DOES: drops that one CHECK. Rows are untouched (the 7 existing payers keep their type), and an empty type was always accepted,
-- so the code fix (no type written) works with or without this migration — order does not matter. On the SANDBOX the constraint does not
-- exist, so this is a no-op there (IF EXISTS).
--
-- AFTER THIS RUNS ON PRODUCTION: refresh db/constraints.prod.json (npm run snapshot:constraints) and delete
-- "billing_entities_entity_type_check" from UNAUDITED_BASELINE in lib/db-contract.ts, in the same follow-up change. Until then the
-- production drift cron reports the missing rule.
-- UNDO: 20261121-0100-billing-entity-type-drop-fixed-list.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.billing_entities DROP CONSTRAINT IF EXISTS billing_entities_entity_type_check;

COMMIT;
