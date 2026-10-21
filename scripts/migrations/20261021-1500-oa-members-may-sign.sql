-- Operating Agreement: a two-member agreement can say each Member may also sign for the Company (Antonio, 2026-10-21; Beril LLC).
-- A setting frozen on the agreement itself, like previous_company_name. Default false = the Manager alone, exactly today's wording,
-- so every existing agreement is untouched. Only the agreement that is set to true prints the new Section 2.3.
-- APPLY THIS BEFORE THE CODE THAT READS IT (the OA pages select the column; without it they fail). Instant; no table rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.oa_agreements ADD COLUMN IF NOT EXISTS members_may_sign boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.oa_agreements.members_may_sign IS 'Two-member agreements: true = each Member may also sign for and bind the Company (Section 2.3). Frozen with the agreement.';

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'oa_agreements' AND column_name = 'members_may_sign') THEN
    RAISE EXCEPTION 'oa-members-may-sign: the column is missing after the change';
  END IF;
END
$do$;
COMMIT;

SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'oa_agreements' AND column_name = 'members_may_sign';
