-- Undo for 20261102-1800-offer-invoice-description.sql (drops the one additive column).
ALTER TABLE public.offers DROP COLUMN IF EXISTS invoice_description;
