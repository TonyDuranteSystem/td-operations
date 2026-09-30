-- UNDO for 20260930-2300-n0-lock-offers-contracts-renewals.sql (N0, dev job f907220c).
--
-- Puts back EXACTLY the production rules as they were on 2026-09-30 (read from pg_policies
-- and information_schema before the lock). Use only if the lock breaks signing and the
-- code cannot be fixed fast — it reopens the security hole N0 closes.

BEGIN;

-- offers
DROP POLICY IF EXISTS "offers_staff_read" ON public.offers;
DROP POLICY IF EXISTS "Allow public read by token" ON public.offers;
CREATE POLICY "Allow public read by token" ON public.offers FOR SELECT TO public USING (true);
DROP POLICY IF EXISTS "Allow service update" ON public.offers;
CREATE POLICY "Allow service update" ON public.offers FOR UPDATE TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_read" ON public.offers;
CREATE POLICY "auth_read" ON public.offers FOR SELECT TO authenticated USING (true);
GRANT SELECT, UPDATE, REFERENCES, TRIGGER ON public.offers TO anon;

-- contracts
DROP POLICY IF EXISTS "contracts_staff_read" ON public.contracts;
DROP POLICY IF EXISTS "Allow public insert contracts" ON public.contracts;
CREATE POLICY "Allow public insert contracts" ON public.contracts FOR INSERT TO public WITH CHECK (true);
DROP POLICY IF EXISTS "Allow public read contracts by offer_token" ON public.contracts;
CREATE POLICY "Allow public read contracts by offer_token" ON public.contracts FOR SELECT TO public USING (true);
DROP POLICY IF EXISTS "Allow public update contracts" ON public.contracts;
CREATE POLICY "Allow public update contracts" ON public.contracts FOR UPDATE TO public USING (true);
GRANT SELECT, INSERT, UPDATE, REFERENCES, TRIGGER ON public.contracts TO anon;

-- annual_agreements (policies were never touched)
GRANT SELECT, UPDATE, REFERENCES, TRIGGER ON public.annual_agreements TO anon;

-- storage
DROP POLICY IF EXISTS "Allow public upload signed contracts" ON storage.objects;
CREATE POLICY "Allow public upload signed contracts" ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id = 'signed-contracts');
DROP POLICY IF EXISTS "Allow public upload to wire-receipts" ON storage.objects;
CREATE POLICY "Allow public upload to wire-receipts" ON storage.objects FOR INSERT TO anon WITH CHECK (bucket_id = 'wire-receipts');

COMMIT;
