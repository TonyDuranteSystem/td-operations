-- Portal Chats list: which conversations have a message written by a PERSON?
-- Dev job 5a87f5c2 (2026-11-10). Antonio: add a "Chats" chip to the staff conversation list that
-- hides conversations holding only automatic notices (client signed / paid / uploaded, out-of-office
-- replies, bank-statement notes). "A person wrote" = sender_type 'client' or 'admin'; 'system' is a notice.
--
-- Returns the KEY of every conversation that has at least one such message, in the SAME key shape and
-- with the SAME ownership rules as get_portal_chat_threads_v2 (which is left untouched — the MCP tools
-- and lib/portal/thread-scope.ts also call it):
--   * account-level thread (multi-member LLC): (contact_id NULL, account_id = the account)
--   * contact-level thread: (contact_id = the person, account_id NULL)
-- The route marks each thread from this list; if this function is not installed yet the route simply
-- leaves the flag off and the "Chats" chip shows everything (same as "All") — never an empty list.
--
-- Built set-based on purpose: ONE pass over the person-written messages, then joins. The obvious
-- "EXISTS per contact" form took ~50 s on the sandbox (measured); this one is a fraction of a second.
--
-- Read-only. Service role only (same lock-down as the other portal-chat thread functions).

CREATE OR REPLACE FUNCTION public.get_portal_chat_people_thread_keys()
 RETURNS TABLE(contact_id uuid, account_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public
AS $function$
  WITH multi_contact_accounts AS (
    SELECT ac.account_id
    FROM account_contacts ac
    WHERE ac.account_id IS NOT NULL
    GROUP BY ac.account_id
    HAVING COUNT(DISTINCT ac.contact_id) > 1
  ),
  -- every distinct (person, company) pair that has a person-written, non-deleted message
  people AS (
    SELECT DISTINCT pm.contact_id AS p_contact_id, pm.account_id AS p_account_id
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND pm.sender_type IN ('client', 'admin')
  )

  -- Account-level threads: a multi-member account with a person-written message (any contact).
  SELECT NULL::uuid AS contact_id, a.id AS account_id
  FROM accounts a
  WHERE a.id IN (SELECT mca.account_id FROM multi_contact_accounts mca)
    AND a.id IN (SELECT p.p_account_id FROM people p WHERE p.p_account_id IS NOT NULL)

  UNION

  -- Contact-level threads (a): the person's own messages, personal or on a non-multi-member company.
  SELECT c.id AS contact_id, NULL::uuid AS account_id
  FROM contacts c
  WHERE c.id IN (
    SELECT p.p_contact_id FROM people p
    WHERE p.p_contact_id IS NOT NULL
      AND (p.p_account_id IS NULL
           OR p.p_account_id NOT IN (SELECT mca.account_id FROM multi_contact_accounts mca))
  )

  UNION

  -- Contact-level threads (b): company-only messages (no person on the row) on a non-multi-member
  -- company belong to every person linked to that company.
  SELECT ac.contact_id AS contact_id, NULL::uuid AS account_id
  FROM account_contacts ac
  JOIN contacts c2 ON c2.id = ac.contact_id
  WHERE ac.account_id IN (
    SELECT p.p_account_id FROM people p
    WHERE p.p_contact_id IS NULL
      AND p.p_account_id IS NOT NULL
      AND p.p_account_id NOT IN (SELECT mca.account_id FROM multi_contact_accounts mca)
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.get_portal_chat_people_thread_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_portal_chat_people_thread_keys() TO service_role;
