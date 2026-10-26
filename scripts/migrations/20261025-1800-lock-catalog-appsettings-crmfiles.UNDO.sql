-- Undo of 20261025-1800-lock-catalog-appsettings-crmfiles.sql: restores the previous (insecure) access. Use only to roll back a breakage.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_entries', 'app_settings'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS logged_in_not_marketing ON public.%I', t);
    EXECUTE format($f$CREATE POLICY logged_in_not_marketing ON public.%I FOR ALL TO authenticated
                      USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'marketing')
                      WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'marketing')$f$, t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS crm_files_bucket_staff_only ON storage.objects;
CREATE POLICY crm_files_bucket_staff_only ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'crm-files' AND coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'))
  WITH CHECK (bucket_id = 'crm-files' AND coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'));
