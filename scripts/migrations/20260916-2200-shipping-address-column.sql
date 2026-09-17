-- Migration: 20260916-2200-shipping-address-column
-- Purpose: Add a 4th, independent address slot ("Shipping Address") to the
-- account address registry, alongside the existing Legal/Mailing/Registered
-- Agent slots added in 20260503-2200-address-registry-prod-backfill.sql.
--
-- Antonio's ruling (dev job 254834cc, 2026-09-16): Legal Address is not a
-- stable place to ship things (it's TD's own office for a company TD formed,
-- or a client's pre-existing old address for a company onboarded from
-- elsewhere) — clients need a separate, stable Shipping Address slot. This
-- is purely additive: a new nullable FK + a new boolean flag, matching the
-- exact shape of the three existing pairs. No existing row or column is
-- touched. The actual Shipping address ROW is seeded separately by
-- scripts/seed-shipping-address.js (which imports the address text from
-- lib/td-address.ts, the single source of truth — never hand-type it here;
-- see tests/unit/td-address-single-source.test.ts).

-- ─── accounts columns ───────────────────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS shipping_address_id     uuid,
  ADD COLUMN IF NOT EXISTS shipping_link_verified  boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'accounts_shipping_address_id_fkey' AND table_name = 'accounts'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_shipping_address_id_fkey
      FOREIGN KEY (shipping_address_id) REFERENCES public.addresses(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ─── widen addresses.kind to allow 'shipping' ───────────────────────
-- Sandbox carries a CHECK constraint restricting kind to the original 3
-- values (production does not — confirmed via pg_constraint on both, this
-- session). Widen it idempotently so this migration is safe to re-run and
-- safe to promote to an environment that may or may not already have the
-- constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.addresses'::regclass
      AND conname = 'addresses_kind_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%shipping%'
  ) THEN
    ALTER TABLE public.addresses DROP CONSTRAINT addresses_kind_check;
    ALTER TABLE public.addresses ADD CONSTRAINT addresses_kind_check
      CHECK (kind = ANY (ARRAY['business_legal'::text, 'business_mailing'::text, 'registered_agent'::text, 'shipping'::text]));
  END IF;
END$$;
