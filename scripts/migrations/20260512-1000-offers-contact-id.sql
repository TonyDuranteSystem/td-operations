-- 20260512-1000-offers-contact-id.sql
-- Add contact_id FK to offers table.
--
-- Context: commit 91eec1d1 (partner-portal phase 3, 2026-05-10) added
-- contact_id to CreateOfferParams and the createOffer() INSERT statement.
-- The column was applied to sandbox but the migration was never written or
-- promoted to production. Every offer creation in production fails with:
--   "Could not find the contact_id column of the offer in the schema cache"
-- because PostgREST rejects an INSERT that references a non-existent column.
--
-- Sandbox already has this column (verified 2026-05-12). This migration
-- is a no-op on sandbox (IF NOT EXISTS guard) and fixes production.

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id);

CREATE INDEX IF NOT EXISTS idx_offers_contact_id
  ON public.offers(contact_id)
  WHERE contact_id IS NOT NULL;
