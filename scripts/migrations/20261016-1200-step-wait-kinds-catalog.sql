-- "Who we wait on" becomes an editable list (dev job 40235e3c, Antonio 2026-10-16: "option 2").
--
-- The "waiting on someone else" kinds of a service step (an outside office, the IRS, the bank, a date...) move from a fixed list in code AND a
-- database CHECK into the catalog `step_wait_kinds`, so Antonio adds a kind from the Service Catalog without a deploy. `us`, `client` and `none`
-- stay built in (the rules key off them) and are NOT catalog rows. A kind is {slug, display_name, metadata.behaviour: 'other' | 'date'}.
--
-- SAFE BEFORE OR AFTER THE CODE: the code falls back to the two seeded kinds until this runs, and works with the old CHECK; this migration is the
-- ON switch (the manager on the Service Catalog page stays inert until the catalog definition exists). NO step is changed: every stored value
-- ('us','client','outside','date','none') keeps its slug and meaning.
--
--   1. register the catalog + seed the two existing kinds (ON CONFLICT DO NOTHING: a re-run never overwrites a rename or a retire);
--   2. replace the 5-value CHECK with a static SHAPE rule (lower-case snake_case slug). The list of real kinds is now data, so the application
--      validates a NEW choice against it (lib/services/stages.ts); a value that stops existing shows as "not set" with a visible warning.
-- UNDO: 20261016-1200-step-wait-kinds-catalog.UNDO.sql (re-points any custom kind to its behaviour's seed slug first).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"wait-kinds-migration"}', true);

INSERT INTO public.catalog_definitions (id, display_name, description, admin_can_add_rows)
VALUES (
  'step_wait_kinds',
  'Step — waiting on someone else',
  'Kinds of "waiting on someone else" a service step can have (an outside office, the IRS, the bank, a date...). Slug = stable id (never changed). display_name = the name shown. metadata.behaviour = other (waits on someone else: Pending, late by the step''s follow-up days) | date (waits for a date: Pending, never late); set when the kind is created and not changed after. us / client / none are built in and are not rows here.',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('step_wait_kinds', 'outside', 'An outside office', 'active', '{"behaviour":"other"}'::jsonb),
  ('step_wait_kinds', 'date',    'A date',            'active', '{"behaviour":"date"}'::jsonb)
ON CONFLICT (catalog_id, slug) DO NOTHING;

ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_waiting_on_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_waiting_on_shape') THEN
    ALTER TABLE public.pipeline_stages ADD CONSTRAINT pipeline_stages_waiting_on_shape
      CHECK (waiting_on IS NULL OR waiting_on ~ '^[a-z][a-z0-9_]{0,40}$');
  END IF;
END $$;

COMMENT ON COLUMN public.pipeline_stages.waiting_on IS
  'Who must act next while a job sits on this step: a kind slug — built in (us | client | none) or a row of the catalog step_wait_kinds (outside, date, ...). NULL = not set. The shape is checked here; whether the kind exists is checked by the application (lib/services/stages.ts).';

COMMIT;
