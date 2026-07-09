-- Add referrer_contact_id to offers so a referrer can be pinned to an exact
-- CONTACT by ID (not just by free-text name or by account).
--
-- Why: the Create Offer referrer was free text. At payment/activation the
-- pay->credit chain (activate-service Step 3.5) matched that free text against
-- contacts by name (ILIKE) and, on no match, CREATED a brand-new contact — a
-- fragile step that mis-attributes or duplicates the referrer, so the referral
-- Credit Note (CN-) could land on the wrong person. The new Create Offer
-- referrer PICKER selects a real contact/account/partner and stores its id here,
-- letting Step 3.5 resolve the referrer deterministically. Free text still works
-- as a fallback (both ids null -> old name-match/create path).
--
-- offers.referrer_account_id already exists (company/partner referrer). This
-- column is the missing CONTACT counterpart. Nullable; no backfill.

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS referrer_contact_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'offers_referrer_contact_id_fkey'
      AND table_name = 'offers'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_referrer_contact_id_fkey
      FOREIGN KEY (referrer_contact_id) REFERENCES public.contacts(id);
  END IF;
END $$;
