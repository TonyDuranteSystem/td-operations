-- Undo for 20261018-0200: gives logged-in users (authenticated) back EXECUTE on the functions it locked. DANGEROUS: this re-opens
-- exec_sql(text) (any SQL as the database owner) to every logged-in client. Only run it to diagnose a break, then re-run 0200.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
      AND p.proname !~ '^(_|trg_)' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
  END LOOP;
END $$;
