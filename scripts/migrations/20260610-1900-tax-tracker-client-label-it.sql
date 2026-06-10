-- Slice 5 (Tax Submission Review Workflow REV 4.1): client progress tracker
--
-- Adds client_label_it to pipeline_stages so the portal progress tracker is
-- bilingual AND catalog-driven (same principle as client_label from Slice 1:
-- labels editable from the catalog, no deploy needed).
--
-- Backfills Italian labels for the 13 client-facing Tax Return stages
-- (the ones Slice 1 gave a client_label). Stages without a client_label
-- (Company Data Pending, Paid - Awaiting Data, Data Received,
-- Terminated - Non Payment) stay NULL — they never render in the tracker.
--
-- Fallback chain in code: client_label_it → client_label → stage_name.

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS client_label_it TEXT;

UPDATE pipeline_stages SET client_label_it = v.label_it
FROM (VALUES
  ('1st Installment Paid',     'Prima Rata Pagata'),
  ('Extension Filed',          'Proroga Presentata'),
  ('Awaiting 2nd Payment',     'In Attesa della Seconda Rata'),
  ('2nd Installment Paid',     'Seconda Rata Pagata'),
  ('Wizard Available',         'Modulo Disponibile'),
  ('Data Submitted',           'Dati Inviati'),
  ('Under Review',             'In Revisione'),
  ('Revision Requested',       'Modifiche Richieste'),
  ('Approved',                 'Approvato'),
  ('Confirmed',                'Confermato'),
  ('Preparation',              'Dal Commercialista'),
  ('TR Completed',             'Pronto per la Firma'),
  ('TR Filed',                 'Presentata')
) AS v(stage_name, label_it)
WHERE pipeline_stages.service_type = 'Tax Return'
  AND pipeline_stages.stage_name = v.stage_name;
