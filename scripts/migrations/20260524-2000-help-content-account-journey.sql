-- migration:20260524-2000-help-content-account-journey.sql
--
-- Help content (Slice 3) — Account pages: the Account Journey stepper. Authored
-- by Claude from components/accounts/account-journey.tsx (the 6-step derivation).
-- Idempotent.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('help_content','account.journey','Account journey','active','{"area":"Account pages","order":5,"what":"A map of where this company is in its lifecycle, worked out automatically from its offer, payment, onboarding wizard, and services: Offer → Signed → Paid → Onboarding → Services → Active.","on_click":"","next":"Read the dots: green = done, blue = the current step, grey = not there yet, amber \"!\" = needs attention (e.g. payment overdue, or onboarding not started days after paying). Hover any step for dates and details. The cards underneath show which client forms/wizards are submitted."}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
