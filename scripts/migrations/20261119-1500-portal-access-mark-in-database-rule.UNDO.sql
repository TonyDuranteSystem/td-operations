-- Undo of 20261119-1500-portal-access-mark-in-database-rule.sql: puts the production definition back exactly as it was on 19 Nov
-- (every link counts, whether or not it carries the no-access mark). Safe to run at any time.
CREATE OR REPLACE FUNCTION public.get_client_account_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT account_id FROM account_contacts
  WHERE contact_id = (auth.jwt() -> 'app_metadata' ->> 'contact_id')::uuid
$function$;
