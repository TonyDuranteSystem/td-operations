-- Member portal access, delivery A (dev job beb43385). SANDBOX FIRST, then production by hand.
-- WHAT: the database rule behind the browser-side checks (get_client_account_ids, used by ~25 production policies) answers
--   "which companies is this logged-in person linked to?". From now on it leaves out a link that carries the no-access mark
--   (account_contacts.access_revoked_at), the same way the portal code now does.
-- WHY IT IS SAFE TODAY: no link carries the mark (production, read only, 19 Nov: 408 links, 0 marked), so the answer is
--   unchanged for everybody until a member is deliberately given "no access".
-- SANDBOX NOTE: sandbox did not have this function at all (and has no policies that call it); this file creates it there, with the
--   production shape, so the function itself can be tested. On production this only REPLACES the body: owner and grants are kept.
-- Idempotent. Undo: 20261119-1500-portal-access-mark-in-database-rule.UNDO.sql
CREATE OR REPLACE FUNCTION public.get_client_account_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT account_id FROM account_contacts
  WHERE contact_id = (auth.jwt() -> 'app_metadata' ->> 'contact_id')::uuid
    AND access_revoked_at IS NULL
$function$;
