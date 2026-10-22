-- UNDO of 20261022-0900-service-delivery-notes.sql (drops the notes; only run if nobody has written one you want to keep).
BEGIN;
DROP TABLE IF EXISTS public.service_delivery_notes;
COMMIT;
