-- Undo of 20261026-1000-service-contract-texts.sql.
-- WARNING: dropping offers.contract_texts deletes the frozen wording snapshots of offers sent with a NEW service's contract
-- (the signed PDFs keep what the client saw), and dropping the table deletes every stored version and its approval record.
-- Safe only while no offer has been sent with a stored contract. Nothing else reads these objects when no new service exists.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.offers DROP COLUMN IF EXISTS contract_texts;
DROP FUNCTION IF EXISTS public.approve_service_contract_text(uuid, text, text);
DROP TABLE IF EXISTS public.service_contract_texts;
DROP FUNCTION IF EXISTS public.service_contract_texts_guard();
COMMIT;
