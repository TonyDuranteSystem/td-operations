-- 20260509-0001-partner-config-columns.sql
-- Partner Portal Phase 1, Migration 1/3.
-- Adds partner-level default config to client_partners. Existing commission_model
-- column stays for backward compat; new code reads default_payout_model.
-- No is_active column: existing status column is the soft-disable signal
-- (status='inactive' deactivates a partner).

ALTER TABLE public.client_partners
  ADD COLUMN IF NOT EXISTS default_invoice_target TEXT NOT NULL DEFAULT 'partner',
  ADD COLUMN IF NOT EXISTS default_payout_model   TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS default_payout_rate    NUMERIC,
  ADD COLUMN IF NOT EXISTS label                  TEXT,
  ADD COLUMN IF NOT EXISTS td_base_costs          JSONB DEFAULT '{}'::jsonb;
