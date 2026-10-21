-- ITIN: a new stage "Shipped" between "Client Signing" and "Documents Received" (Antonio, 2026-10-21; Luca's td-bug on Alex Tumbarello / Graziella Lazzara).
-- WHY: the client saving the courier + tracking number in the portal moved the case to "Documents Received" — a client action filed under a name that means
-- "the office received it". Now: the client's tracking entry (or staff "Mark client has mailed") = "Shipped"; the office's own button = "Documents Received".
-- WHAT: (1) a new pipeline_stages row 'Shipped' at order 4, the later ITIN stages shift by one — and so does the stored order number on every ITIN case and on the tasks linked to an ITIN case; (2) the catalog chain's client_mailed transition now targets 'Shipped'.
-- Existing cases are NOT moved. APPLY THIS BEFORE THE CODE THAT TARGETS 'Shipped' (the old code keeps working with the new stage in place). Idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  v_dr record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'ITIN' AND stage_name = 'Shipped') THEN
    RAISE NOTICE 'itin-shipped-stage: already there — skipping the stage insert';
  ELSE
    SELECT * INTO v_dr FROM public.pipeline_stages WHERE service_type = 'ITIN' AND stage_name = 'Documents Received';
    IF v_dr.id IS NULL THEN RAISE EXCEPTION 'itin-shipped-stage: the ITIN stage "Documents Received" was not found'; END IF;
    IF v_dr.stage_order <> 4 THEN RAISE EXCEPTION 'itin-shipped-stage: expected "Documents Received" at order 4, found %', v_dr.stage_order; END IF;

    -- make room at order 4 (two steps: the unique (service_type, stage_order) is checked row by row)
    UPDATE public.pipeline_stages SET stage_order = stage_order + 1000 WHERE service_type = 'ITIN' AND stage_order >= 4;
    UPDATE public.pipeline_stages SET stage_order = stage_order - 999  WHERE service_type = 'ITIN' AND stage_order >= 1004;

    -- every ITIN case (and the tasks linked to a stage of an ITIN case) stores the stage's ORDER number: it must move with the stages, or
    -- a case at "CAA Review" would still say 5 and the system would think it is at "Documents Received" (the advance step reads this number)
    UPDATE public.service_deliveries SET stage_order = stage_order + 1 WHERE service_type = 'ITIN' AND stage_order >= 4;
    UPDATE public.tasks SET stage_order = stage_order + 1 WHERE stage_order >= 4 AND delivery_id IN (SELECT id FROM public.service_deliveries WHERE service_type = 'ITIN');

    INSERT INTO public.pipeline_stages (
      service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, auto_advance,
      client_description, service_type_entry_id, notify_client_email, client_label, client_label_it, client_visible, board_visible,
      stage_layout, notify_client_chat, tracking_check_enabled, completes_service, waiting_on, requires_document_to_advance, client_task_in_list
    ) VALUES (
      'ITIN', 4, 'Shipped', 'The client mailed the signed package and entered the courier + tracking number; waiting for it to arrive at the office',
      '[]'::jsonb, '[]'::jsonb, 14, false, true,
      'Your signed documents are on their way to our office. We will let you know when they arrive.', v_dr.service_type_entry_id, false,
      'Documents on their way', 'Documenti in viaggio', true, true,
      jsonb_build_object(
        'description', 'The client has shipped the signed package (courier + tracking below). Click "Documents Received at Office" when it arrives.',
        'components', jsonb_build_array(
          jsonb_build_object('type', 'waiting_notice', 'label', 'Shipped by the client — waiting for the package to arrive at the office.'),
          jsonb_build_object('type', 'shipping_info'),
          jsonb_build_object('type', 'chat'),
          jsonb_build_object('type', 'document_viewer', 'collapsible', true),
          jsonb_build_object('type', 'action_buttons', 'actions', jsonb_build_array(
            jsonb_build_object('key', 'advance_next', 'label', 'Documents Received at Office', 'target', 'Documents Received')))
        )
      ),
      false, false, false, 'outside', false, false
    );
  END IF;
END
$do$;

-- the workflow path: client_mailed (the client's tracking entry, or staff "Mark client has mailed") now lands on 'Shipped'
UPDATE public.catalog_entries
   SET metadata = jsonb_set(metadata, '{workflow_chain,transitions,itin_await_client_mailing,client_mailed,advance_sd_stage}', '"Shipped"'::jsonb, false),
       updated_at = now()
 WHERE catalog_id = 'services' AND slug = 'itin'
   AND metadata #>> '{workflow_chain,transitions,itin_await_client_mailing,client_mailed,advance_sd_stage}' = 'Documents Received';

DO $do$
BEGIN
  IF (SELECT count(*) FROM public.pipeline_stages WHERE service_type = 'ITIN') <> 9 THEN RAISE EXCEPTION 'itin-shipped-stage: expected 9 ITIN stages'; END IF;
  IF (SELECT string_agg(stage_name, ' > ' ORDER BY stage_order) FROM public.pipeline_stages WHERE service_type = 'ITIN')
     <> 'Data Collection > Document Preparation > Client Signing > Shipped > Documents Received > CAA Review > Submitted to IRS > IRS Processing > ITIN Approved'
  THEN RAISE EXCEPTION 'itin-shipped-stage: the stage order is not what was intended'; END IF;
  IF (SELECT metadata #>> '{workflow_chain,transitions,itin_await_client_mailing,client_mailed,advance_sd_stage}' FROM public.catalog_entries WHERE catalog_id = 'services' AND slug = 'itin') IS DISTINCT FROM 'Shipped'
  THEN RAISE EXCEPTION 'itin-shipped-stage: the catalog chain does not target Shipped'; END IF;
END
$do$;
COMMIT;

SELECT stage_order, stage_name, waiting_on, sla_days FROM public.pipeline_stages WHERE service_type = 'ITIN' ORDER BY stage_order;
