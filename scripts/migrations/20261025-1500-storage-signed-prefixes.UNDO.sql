-- UNDO of 20261025-1500-storage-signed-prefixes.sql: back to the five prefixes of 20261025-1200-storage-safe-save.sql.
-- Files saved under the four added prefixes simply become editable in place again; nothing is deleted.
BEGIN;
UPDATE public.app_settings
   SET value = '["esign-signed:","offer-signed:","lease-signed:","oa-signed:","ss4-signed-company:"]'::jsonb, updated_at = now()
 WHERE key = 'store_signed_key_prefixes';
COMMIT;
