-- Pin a lead's referrer to a real client by ID, from the lead stage.
--
-- Why: the Lead detail "Referrer" field was free text (leads.referrer_name only).
-- Staff now pick a real referrer (contact + their company) on the lead; that pins
-- the referrer by ID and creates the referrer<->lead pending referral immediately
-- (even before the lead converts). When the lead pays, the existing lead-keyed
-- credit path (activate-service Step 3.5b / creditReferrerForLead) credits the
-- referrer. leads.referrer_partner_id (legacy partner linkage) is unchanged.
--
-- referrer_contact_id = the referrer person; referrer_account_id = the company
-- whose ledger the referral credit lands on (the "credit goes to" choice). Both
-- nullable; no backfill.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS referrer_contact_id uuid;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS referrer_account_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'leads_referrer_contact_id_fkey' AND table_name = 'leads'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_referrer_contact_id_fkey
      FOREIGN KEY (referrer_contact_id) REFERENCES public.contacts(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'leads_referrer_account_id_fkey' AND table_name = 'leads'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_referrer_account_id_fkey
      FOREIGN KEY (referrer_account_id) REFERENCES public.accounts(id);
  END IF;
END $$;
