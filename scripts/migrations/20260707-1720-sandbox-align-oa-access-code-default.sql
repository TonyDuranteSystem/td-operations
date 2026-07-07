-- Sandbox-only schema alignment (drift repair, no production action needed).
-- Production oa_agreements.access_code already has this default (verified
-- 2026-07-07 via information_schema on prod); sandbox was missing it, so
-- portal self-service OA creation produced NULL access codes and signing
-- links containing "/null" — sandbox QA artifact of the same drift class as
-- the documents.confidence incident (2026-06-25).
ALTER TABLE oa_agreements
  ALTER COLUMN access_code SET DEFAULT substring(md5(random()::text), 1, 8);
