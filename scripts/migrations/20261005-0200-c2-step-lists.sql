-- N1a C2 — DBA and EIN step lists (Antonio 2026-10-04, Google Doc §20). Run AFTER 20261005-0100.
--
-- DBA: replaced by the 8 steps of the real Wyoming case ("Business For Lawyers", filed 2026-09-23: signed by the
--      client, notarized, $100 money order, mailed). Publication removed. Each step has an English + Italian client label
--      (what the client sees in the portal and in step notices; Antonio 2026-10-05 "fix 2"). Refuses if any DBA job exists (0 in
--      production on 2026-10-04 — the steps can only be replaced while nothing points at them).
-- EIN: the client signs the SS-4 — two steps inserted after "SS-4 Preparation", as in Company Formation. Moved by
--      hand (SS-4 signing automation is Company Formation only — every code path that reacts to these names filters
--      on service_type = 'Company Formation'). Refuses if any ACTIVE EIN job exists; completed (imported) EIN jobs
--      keep their step name and get their step number re-synced to the new list.
-- Every change is stamped "c2-migration" in service_settings_history.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"c2-migration"}', true);

-- DBA ---------------------------------------------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'DBA') THEN
    RAISE EXCEPTION 'c2: DBA jobs exist — the DBA steps cannot be replaced by this migration';
  END IF;
END $$;

-- Keep the steps' link to the DBA service card (every old DBA step carries the same one).
CREATE TEMP TABLE c2_dba_link ON COMMIT DROP AS
  SELECT max(service_type_entry_id::text)::uuid AS entry_id FROM public.pipeline_stages WHERE service_type = 'DBA';

DELETE FROM public.pipeline_stages WHERE service_type = 'DBA';

INSERT INTO public.pipeline_stages
  (service_type, stage_order, stage_name, stage_description, waiting_on, completes_service, requires_document_to_advance, auto_advance,
   client_label, client_label_it, service_type_entry_id)
SELECT v.*, (SELECT entry_id FROM c2_dba_link) FROM (VALUES
  ('DBA', 1, 'Name Collection',          'The client gives the DBA name, what the business does and the date the name was first used.', 'client',  false, false, false, 'Tell us your trade name', 'Indicaci il nome commerciale'),
  ('DBA', 2, 'Name Check & Approval',    'We check the name with the state and the client approves it.',                                  'us',      false, false, false, 'Checking your trade name', 'Verifica del nome commerciale'),
  ('DBA', 3, 'Application Prepared',     'The trade-name application is prepared and sent to the client to sign.',                        'client',  false, false, false, 'Sign your DBA application', 'Firma la domanda DBA'),
  ('DBA', 4, 'Notarization',             'The signed application is notarized.',                                                           'us',      false, false, false, 'Notarizing your application', 'Autenticazione notarile della domanda'),
  ('DBA', 5, 'Money Order',              'Buy the filing-fee money order payable to the Secretary of State and upload it.',                'us',      false, true,  false, 'Preparing the state filing fee', 'Preparazione della tassa statale'),
  ('DBA', 6, 'Mailed to State',          'Application and money order mailed to the Secretary of State (up to 15 business days).',          'outside', false, false, false, 'Sent to the state', 'Inviata allo Stato'),
  ('DBA', 7, 'Registered',               'The state registered the trade name. Upload the filed receipt.',                                 'none',    true,  false, false, 'Your trade name is registered', 'Il tuo nome commerciale è registrato'),
  ('DBA', 8, 'Renewal Due',              'The registration lasts 10 years; renewal can be filed up to 6 months before it expires.',        'date',    false, false, false, 'Renewal due', 'Rinnovo in scadenza')
) AS v(service_type, stage_order, stage_name, stage_description, waiting_on, completes_service, requires_document_to_advance, auto_advance,
        client_label, client_label_it);

-- EIN ---------------------------------------------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'EIN' AND status NOT IN ('completed', 'cancelled')) THEN
    RAISE EXCEPTION 'c2: active EIN jobs exist — the EIN steps cannot be renumbered by this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'EIN' AND stage_name IN ('SS-4 Prepared', 'SS-4 Signed')) THEN
    RAISE NOTICE 'c2: EIN signing steps already present — skipping';
    RETURN;
  END IF;

  -- Renumber from the end so each move lands on a free number (stage order is unique per service) and every real
  -- move is recorded in the change history (temporary "park" numbers would be skipped by the history).
  IF (SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) FROM public.pipeline_stages WHERE service_type = 'EIN')
     IS DISTINCT FROM '1:SS-4 Preparation,2:SS-4 Submitted,3:Awaiting EIN,4:EIN Received' THEN
    RAISE EXCEPTION 'c2: unexpected EIN step list — nothing renumbered';
  END IF;
  UPDATE public.pipeline_stages SET stage_order = 6 WHERE service_type = 'EIN' AND stage_name = 'EIN Received';
  UPDATE public.pipeline_stages SET stage_order = 5 WHERE service_type = 'EIN' AND stage_name = 'Awaiting EIN';
  UPDATE public.pipeline_stages SET stage_order = 4 WHERE service_type = 'EIN' AND stage_name = 'SS-4 Submitted';

  INSERT INTO public.pipeline_stages
    (service_type, stage_order, stage_name, stage_description, waiting_on, auto_advance, client_label, client_label_it, service_type_entry_id)
  SELECT v.*, (SELECT max(service_type_entry_id::text)::uuid FROM public.pipeline_stages WHERE service_type = 'EIN')
  FROM (VALUES
    ('EIN', 2, 'SS-4 Prepared', 'SS-4 prepared and sent to the client to sign. Move on by hand once signed.', 'client', false, 'Sign your SS-4', 'Firma il modulo SS-4'),
    ('EIN', 3, 'SS-4 Signed',   'The client signed the SS-4.',                                                'us',     false, 'SS-4 signed',    'SS-4 firmato')
  ) AS v(service_type, stage_order, stage_name, stage_description, waiting_on, auto_advance, client_label, client_label_it);

  -- Completed (imported) EIN jobs: keep the step NAME, re-sync the step NUMBER to the new list.
  UPDATE public.service_deliveries sd
     SET stage_order = ps.stage_order
    FROM public.pipeline_stages ps
   WHERE sd.service_type = 'EIN' AND ps.service_type = 'EIN' AND ps.stage_name = sd.stage
     AND sd.stage_order IS DISTINCT FROM ps.stage_order;
END $$;

COMMIT;
