-- Company Change Name: the welcome message a client gets in the portal chat when the service is activated (dev job bb64c417, track B2).
-- Data-only (one catalog row in welcome_messages, editable from the CRM /catalog page); idempotent (a row that is already there is left alone,
-- so an edit made later in /catalog is never overwritten). The code side (PIPELINE_TO_WELCOME_SLUG in lib/portal/welcome-message.ts) maps the
-- service to this slug. Wording DRAFT — Antonio approves it before this runs on production.
-- Priority 45 = below the formation/onboarding/tax/banking welcomes, above closure: when a name change is bought together with one of those,
-- THEIR welcome wins (one combined message per offer).
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, metadata)
SELECT 'welcome_messages', 'company_change_name',
       'Welcome — your company name change is being set up',
       '{"it": "Benvenuto — il cambio nome della tua società è in lavorazione"}'::jsonb,
       'Hi {{firstName}}, we''re starting the name change for {{companyName}}. First step: in your portal you will find an "Action required" card asking for up to 3 names you would like for your company — send them one per line, in order of preference. We will check them with the state and come back to you with one that is available. Message us here if anything is unclear.',
       jsonb_build_object('it', 'Caro {{firstName}}, stiamo avviando il cambio nome di {{companyName}}. Primo passo: nel portale trovi un riquadro "Azione richiesta" in cui ti chiediamo fino a 3 nomi che vorresti per la tua società — scrivili uno per riga, in ordine di preferenza. Li verificheremo con lo stato e ti proporremo uno disponibile. Scrivici qui se qualcosa non è chiaro.'),
       'active',
       '{"priority": 45, "wizard_path": "/portal"}'::jsonb
 WHERE EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'welcome_messages')
   AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'company_change_name');

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'welcome_messages')
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'company_change_name' AND status = 'active') THEN
    RAISE EXCEPTION 'change-name-welcome: the welcome row is missing after the insert';
  END IF;
END
$do$;
COMMIT;

SELECT slug, display_name, metadata FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'company_change_name';
