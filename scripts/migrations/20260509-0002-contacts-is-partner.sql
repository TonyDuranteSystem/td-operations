-- 20260509-0002-contacts-is-partner.sql
-- Partner Portal Phase 1, Migration 2/3.
-- Flag on contacts to mark a contact as a partner.
-- ALTER-only: data population for the existing partners (Maxscale, Fresh Legal
-- Group, Fiscalot, Dr. Marco Boschi) will happen in a follow-up step once
-- sandbox query access is restored and the correct sandbox contact_ids are
-- confirmed.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;
