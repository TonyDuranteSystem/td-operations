-- Storage: the signed-file lock now covers EVERY signed producer (dev job bd21e833 follow-up) — 2026-10-25
-- app_settings 'store_signed_key_prefixes' listed only esign-signed:, offer-signed:, lease-signed:, oa-signed:, ss4-signed-company:.
-- These real producers of signed PDFs were missing, so a signed Form 8832 / signature request / hand-signed OA scan / signed SS-4
-- could still be overwritten in place: 8832-signed:, signature-signed:, oa-handsigned-scan:, ss4-signed:.
-- Idempotent UNION (existing entries are kept, nothing is removed, a second run changes nothing). Every producer was checked first:
-- a changed copy of a locked file is saved as a replacement file by lib/crm-store/replacement.ts, so none of them raises on a re-save.
-- Mirrored in lib/crm-store/signed-prefixes.ts (a unit test keeps the two and the producers in step).
BEGIN;

INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('store_signed_key_prefixes', '[]'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

UPDATE public.app_settings
   SET value = (
         SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x), '[]'::jsonb)
           FROM (
             SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END) AS x
             UNION
             SELECT unnest(ARRAY['esign-signed:', 'offer-signed:', 'lease-signed:', 'oa-signed:', 'ss4-signed-company:',
                                 '8832-signed:', 'signature-signed:', 'oa-handsigned-scan:', 'ss4-signed:'])
           ) q
       ),
       updated_at = now()
 WHERE key = 'store_signed_key_prefixes';

COMMIT;
