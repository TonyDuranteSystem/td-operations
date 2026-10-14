-- Antonio's full legal name is "Antonio Noel Durante" (2026-10-13: "my name is Antonio Noel Durante, change it everywhere").
-- 1) Every NEW lease takes the Provider's signer from this column default (the app now also writes it explicitly).
-- 2) UNSIGNED leases (draft / sent / viewed, not signed) are corrected so they print the full name when they are sent or signed.
--    SIGNED leases are NOT touched — a signed document keeps exactly what was signed.
BEGIN;

ALTER TABLE public.lease_agreements ALTER COLUMN landlord_signer SET DEFAULT 'Antonio Noel Durante';

UPDATE public.lease_agreements
   SET landlord_signer = 'Antonio Noel Durante'
 WHERE landlord_signer = 'Antonio Durante'
   AND status IN ('draft', 'sent', 'viewed')
   AND signed_at IS NULL;

COMMIT;
