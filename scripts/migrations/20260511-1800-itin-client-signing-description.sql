-- ITIN Chain Fix Phase A — Step 5
--
-- The portal stage banner for ITIN clients at "Client Signing" currently reads
-- "Please sign and mail back the documents we sent you." — generic, omits the
-- crucial double-copy + passport-pages instruction that drives the whole
-- physical mailing step.
--
-- Replace it with the exact wording given to clients in the wizard disclaimer
-- so both surfaces agree.

UPDATE pipeline_stages
SET client_description = 'Print the W-7 and 1040-NR in double copy, sign them, include two copies of your passport pages, and mail to our office.'
WHERE service_type = 'ITIN'
  AND stage_name = 'Client Signing';
