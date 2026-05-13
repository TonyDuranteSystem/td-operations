-- Tax Return — Wizard Available rename + One-Time pipeline.
--
-- Sandbox pipeline_stages for service_type='Tax Return' was reordered to a
-- canonical 1..9 sequence. Position 4 was named "2nd Installment Paid", which
-- conflated the *payment event* (a billing milestone) with the *workflow gate*
-- it unblocks (the wizard becomes available to the client). Rename it to
-- "Wizard Available" so the stage name reflects what the client experiences.
--
-- The corresponding tax_return_status enum gets a new 'Wizard Available'
-- value so tax_returns.status can mirror the stage by name. The old value
-- '2nd Installment Paid' remains in the enum for backward compatibility with
-- historical rows; new code maps both to the same SD stage.
--
-- A second pipeline ('Tax Return One-Time') is added for clients who buy a
-- standalone tax return without entering the annual-management bundle. Those
-- clients skip the installment + extension gates and enter directly at
-- "Wizard Available" once their one-time payment clears. service_type_entry_id
-- is left NULL — no separate catalog_entries row has been seeded for this
-- variant yet, and the SD framework treats missing entries as warn-and-skip.
--
-- Apply to SANDBOX via the sandbox MCP execute_sql tool with
-- reason='migration:20260513-tax-return-wizard-available.sql' (R105).
-- DO NOT run via psql.

ALTER TYPE tax_return_status ADD VALUE IF NOT EXISTS 'Wizard Available';

UPDATE pipeline_stages
SET stage_name = 'Wizard Available',
    client_description = 'Your tax data collection form is ready. Please fill it in the portal.'
WHERE service_type = 'Tax Return'
  AND stage_name = '2nd Installment Paid';

INSERT INTO pipeline_stages (
  service_type,
  stage_order,
  stage_name,
  client_description,
  auto_advance,
  notify_client_email,
  requires_approval,
  service_type_entry_id
)
SELECT
  'Tax Return One-Time',
  v.stage_order,
  v.stage_name,
  v.client_description,
  true,
  false,
  false,
  NULL::uuid
FROM (
  VALUES
    (1, 'Wizard Available',        'Your tax data collection form is ready. Please fill it in the portal.'),
    (2, 'Extension Filed',         'We filed an extension for your tax return.'),
    (3, 'Data Received',           'We received your tax data and are reviewing it.'),
    (4, 'Preparation',             'Your tax return is being prepared by our accountant.'),
    (5, 'TR Completed',            'Your tax return is ready for your signature.'),
    (6, 'TR Filed',                'Your tax return has been filed.'),
    (7, 'Terminated - Non Payment', 'This tax return has been terminated.')
) AS v(stage_order, stage_name, client_description)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.service_type = 'Tax Return One-Time'
    AND ps.stage_order  = v.stage_order
);
