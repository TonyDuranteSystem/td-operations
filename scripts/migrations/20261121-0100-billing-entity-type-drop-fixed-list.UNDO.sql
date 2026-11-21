-- UNDO for 20261121-0100-billing-entity-type-drop-fixed-list.sql (dev job 709ac868): puts the fixed list of payer types back.
-- Only run it if every billing_entities.entity_type is empty or one of the eight words below, otherwise the ADD fails (it checks existing rows).
-- With this rule back, a typed payer must be saved with NO type (the code does that) — writing any other word is refused again.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.billing_entities DROP CONSTRAINT IF EXISTS billing_entities_entity_type_check;
ALTER TABLE public.billing_entities
  ADD CONSTRAINT billing_entities_entity_type_check
  CHECK ((entity_type = ANY (ARRAY['SRL'::text, 'SRLS'::text, 'SPA'::text, 'ditta_individuale'::text, 'persona_fisica'::text, 'GmbH'::text, 'Ltd'::text, 'other'::text])));

COMMIT;
