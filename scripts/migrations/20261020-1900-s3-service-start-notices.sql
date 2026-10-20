-- S3 of the workspace-only plan (dev job 0a07e0cd): the client is told what started and what waits on them.
-- Two data changes, nothing else, both idempotent and both inert until the go-live switch is set
-- (app_settings key service_start_notices_go_live — set on purpose, never here):
--   1. pipeline_stages.client_task_in_list — an opt-in flag. A step with the flag AND waiting_on='client' gets a line in the portal's
--      "Action Items" box for services created after go-live. Default false: every other step stays silent, so a step whose
--      "whose turn" tag is wrong (Banking "Awaiting Verification", Consulting "To Schedule", ...) can never show a wrong line.
--      Switched on for: Company Change Name steps 1, 3, 7 and the ITIN "Client Signing" step (each has a client page to open).
--   2. One catalog row in welcome_messages (slug service_started): the first message (chat) + bell title for services where WE act
--      first (Public Notary, Shipping, Certificate of Incumbency, EIN Change Name). Editable in the CRM /catalog page. The
--      welcome resolver never picks it (it only looks up slugs mapped from the contract's services), so no welcome changes.
-- Wording approved by Antonio 2026-10-20 ("Ciao" is fine). Undo: 20261020-1900-s3-service-start-notices.UNDO.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS client_task_in_list boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pipeline_stages.client_task_in_list IS
  'Opt-in: a step with waiting_on=client AND this flag shows as a line in the portal Action Items box (services created after the S3 go-live only). The line uses client_label / client_label_it.';

UPDATE public.pipeline_stages
   SET client_task_in_list = true
 WHERE waiting_on = 'client'
   AND client_label IS NOT NULL
   AND (
        (service_type = 'Company Change Name' AND stage_name IN ('Collect three company names', 'Client signs the name-change form', 'Client updates the Operating Agreement'))
     OR (service_type = 'ITIN' AND stage_name = 'Client Signing')
   );

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, metadata)
SELECT 'welcome_messages', 'service_started',
       '{{serviceName}} — nothing needed from you for now',
       '{"it": "{{serviceName}} — per ora non devi fare nulla"}'::jsonb,
       'Hi {{firstName}}, your {{serviceName}} for {{companyName}} has started. Nothing is needed from you right now. We will write to you here as soon as we need something, or when it is done.',
       jsonb_build_object('it', 'Ciao {{firstName}}, il servizio {{serviceName}} per {{companyName}} è partito. Per ora non devi fare nulla. Ti scriviamo qui appena ci serve qualcosa, oppure quando è completato.'),
       'active',
       '{"priority": 0, "kind": "service_started"}'::jsonb
 WHERE EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'welcome_messages')
   AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'service_started');

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pipeline_stages' AND column_name = 'client_task_in_list') THEN
    RAISE EXCEPTION 's3: the client_task_in_list column is missing after the change';
  END IF;
  IF (SELECT count(*) FROM public.pipeline_stages WHERE client_task_in_list) <> 4 THEN
    RAISE EXCEPTION 's3: expected exactly 4 steps switched on for the Action Items box (Change Name 1/3/7 + ITIN Client Signing), found %', (SELECT count(*) FROM public.pipeline_stages WHERE client_task_in_list);
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'welcome_messages')
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'service_started' AND status = 'active') THEN
    RAISE EXCEPTION 's3: the service_started message row is missing after the insert';
  END IF;
END
$do$;
COMMIT;

SELECT service_type, stage_order, stage_name, waiting_on, client_label, client_task_in_list FROM public.pipeline_stages WHERE client_task_in_list ORDER BY service_type, stage_order;
SELECT slug, display_name, status FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'service_started';
