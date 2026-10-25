-- SECURITY (deep bug hunt 2026-10-25). SANDBOX FIRST, then production by hand.
-- (1) public.catalog_entries and public.app_settings carried the permissive policy logged_in_not_marketing (FOR ALL TO authenticated,
--     role <> 'marketing') plus table grants to anon/authenticated: any logged-in token (a portal CLIENT included) could read AND
--     write the storage document-type flags and the app settings (storage_app_allowed_emails, storage_app_release, ...).
--     Fix: drop every non-restrictive policy and take the table privileges away from anon / authenticated / PUBLIC. Only the
--     service role (server code, supabaseAdmin) reaches them. Checked 2026-10-25: no user-session or browser client reads either table
--     (see docs/systems/storage.md "Locked tables"). The marketing_blocked RESTRICTIVE policy stays (harmless, ANDs with nothing).
--     NOTE: marketing_lock_all_tables() only re-adds logged_in_not_marketing when RLS is OFF, so it will not bring the policy back.
-- (2) storage.objects policy crm_files_bucket_staff_only was a deny-list (role NOT IN client, partner): marketing and role-less
--     tokens reached every CRM Storage library file through the Storage REST API. Replaced with an ALLOW-list (admin, team).
--     Server routes use the service role and are unaffected.
-- Idempotent. Undo: 20261025-1800-lock-catalog-appsettings-crmfiles.UNDO.sql
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_entries', 'app_settings'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND permissive = 'PERMISSIVE' LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS crm_files_bucket_staff_only ON storage.objects;
CREATE POLICY crm_files_bucket_staff_only ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'crm-files' AND lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) IN ('admin', 'team'))
  WITH CHECK (bucket_id = 'crm-files' AND lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) IN ('admin', 'team'));
