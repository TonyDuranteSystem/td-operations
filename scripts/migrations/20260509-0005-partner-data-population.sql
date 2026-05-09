-- 20260509-0005-partner-data-population.sql
-- Partner Portal Phase 1 — data population (closes Phase 1 of build plan v2.1).
-- Sets per-partner config defaults on the four real partners and flips
-- contacts.is_partner = true for their primary contacts.
--
-- Source of truth: sysdoc partner-portal-build-plan v2.1 §2.2.
-- Note: v2.1 §2.2 also references is_active=true; that column was deliberately
-- not added (per Antonio's instruction to use the existing status column for
-- soft-disable). No is_active write here.
--
-- Sandbox contact_ids verified by query on 2026-05-08:
--   Maxscale         → Maxence Van Beneden  634fe3c6-73c5-4018-b84a-0caf303b4fa7
--   Fresh Legal      → (zeev@freshportugal) f3497307-41ac-493e-89a4-7e8265e2c666
--   Fiscalot         → Luca Comaggi          285bd273-3563-4fa7-a9ef-d1e24e384e46
--   Dr. Marco Boschi → Marco Boschi          aa1c64a2-0907-4953-9f8b-71f41631ea11
--
-- Idempotent: every statement is keyed on contact_id and uses absolute SETs.
-- Test Partner (sandbox-only fixture) is intentionally not touched.

-- 1. Reseller defaults: Maxscale, Fresh Legal Group, Fiscalot.
-- Migration 1 already gave them default_invoice_target='partner' and
-- default_payout_model='none' (column defaults). Only label needs to be set.
UPDATE public.client_partners
   SET label = 'reseller'
 WHERE contact_id IN (
   '634fe3c6-73c5-4018-b84a-0caf303b4fa7',
   'f3497307-41ac-493e-89a4-7e8265e2c666',
   '285bd273-3563-4fa7-a9ef-d1e24e384e46'
 );

-- 2. Variant defaults: Dr. Marco Boschi.
UPDATE public.client_partners
   SET default_invoice_target = 'end_client',
       default_payout_model   = 'price_difference',
       label                  = 'variant'
 WHERE contact_id = 'aa1c64a2-0907-4953-9f8b-71f41631ea11';

-- 3. Flip is_partner on the four partner primary contacts.
UPDATE public.contacts
   SET is_partner = true
 WHERE id IN (
   '634fe3c6-73c5-4018-b84a-0caf303b4fa7',
   'f3497307-41ac-493e-89a4-7e8265e2c666',
   '285bd273-3563-4fa7-a9ef-d1e24e384e46',
   'aa1c64a2-0907-4953-9f8b-71f41631ea11'
 );
