BEGIN;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.oa_agreements WHERE members_may_sign IS TRUE) THEN
    RAISE EXCEPTION 'oa-members-may-sign UNDO: % agreement(s) use it — nothing changed', (SELECT count(*) FROM public.oa_agreements WHERE members_may_sign IS TRUE);
  END IF;
END
$do$;
ALTER TABLE public.oa_agreements DROP COLUMN IF EXISTS members_may_sign;
COMMIT;
