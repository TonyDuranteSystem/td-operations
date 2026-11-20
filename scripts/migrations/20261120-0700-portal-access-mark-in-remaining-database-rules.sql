-- Member portal access, delivery C part 2 (dev job beb43385). SANDBOX FIRST, then production by hand (Antonio pastes it).
-- WHAT: five more places in the database still treated a link that carries the no-portal-access mark
--   (account_contacts.access_revoked_at) as a normal link. After this file they leave it out, the same way
--   get_client_account_ids() (delivery A) and the portal code already do:
--     1. policy annual_agreements.client_read_own   — a marked person no longer reads the company's annual agreements
--     2. policy ss4_applications.clients_read_own_ss4 — a marked person no longer reads the company's SS-4s through the company
--        (the first branch, "this SS-4 is MINE" by contact id, is left exactly as it was)
--     3. policy members.members_portal_read          — same rule; on production it compares the contact id with the LOGIN id, so it
--        can never match today (0 links) — changed only so nobody trusts it by mistake
--     4. function get_portal_chat_threads_v2()        — the staff chat list: a marked person no longer counts toward "2+ people =
--        shared company thread", is not listed as a member of it, and is not given the company's messages in their own thread
--     5. function get_portal_chat_people_thread_keys() — the same rule for the staff list of thread keys
--   (4 and 5 make the staff inbox agree with the TypeScript twin multiMemberAccountIds(), which already leaves marked links out.)
-- WHY IT IS SAFE TODAY: no link carries the mark on production (read only, 19 Nov 2026: 408 links, 0 marked), so every answer
--   is unchanged for everybody until a member is deliberately given "no access". Every added condition is "access_revoked_at IS NULL".
-- SANDBOX NOTE: sandbox lacks the two policies in 2 and 3 (the blocks below skip a policy that is not there) and holds the old
--   people-thread-keys function with comments only; this file replaces it with the production shape plus the new condition.
-- Idempotent. Undo: 20261120-0700-portal-access-mark-in-remaining-database-rules.UNDO.sql

-- 1-3. The three read policies (ALTER POLICY keeps the policy's command, roles and permissive flag).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'annual_agreements' AND policyname = 'client_read_own') THEN
    ALTER POLICY client_read_own ON public.annual_agreements
      USING (account_id IN (
        SELECT account_contacts.account_id FROM account_contacts
        WHERE account_contacts.contact_id = (((auth.jwt() -> 'app_metadata'::text) ->> 'contact_id'::text))::uuid
          AND account_contacts.access_revoked_at IS NULL));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ss4_applications' AND policyname = 'clients_read_own_ss4') THEN
    ALTER POLICY clients_read_own_ss4 ON public.ss4_applications
      USING ((contact_id = ((auth.jwt() ->> 'contact_id'::text))::uuid)
        OR (account_id IN (
          SELECT ac.account_id FROM account_contacts ac
          WHERE ac.contact_id = ((auth.jwt() ->> 'contact_id'::text))::uuid
            AND ac.access_revoked_at IS NULL)));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND policyname = 'members_portal_read') THEN
    ALTER POLICY members_portal_read ON public.members
      USING (account_id IN (
        SELECT account_contacts.account_id FROM account_contacts
        WHERE account_contacts.contact_id = auth.uid()
          AND account_contacts.access_revoked_at IS NULL));
  END IF;
END $$;

-- 4. Staff chat list (production definition + "access_revoked_at IS NULL" wherever a link is read).
CREATE OR REPLACE FUNCTION public.get_portal_chat_threads_v2()
 RETURNS TABLE(contact_id uuid, contact_name text, account_id uuid, companies jsonb, members jsonb, last_message text, last_message_at timestamp with time zone, unread_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  -- Structural definition: 2+ distinct linked contacts WHO STILL HAVE PORTAL ACCESS = multi-member account.
  WITH multi_contact_accounts AS (
    SELECT ac.account_id
    FROM account_contacts ac
    WHERE ac.access_revoked_at IS NULL
    GROUP BY ac.account_id
    HAVING COUNT(DISTINCT ac.contact_id) > 1
  )

  -- Branch 1: one account-level thread per multi-member account with messages.
  SELECT
    NULL::UUID        AS contact_id,
    a.company_name    AS contact_name,
    a.id              AS account_id,
    '[]'::JSONB       AS companies,
    COALESCE(
      (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('id', c.id, 'name', c.full_name) ORDER BY c.full_name)
       FROM account_contacts ac2 JOIN contacts c ON c.id = ac2.contact_id
       WHERE ac2.account_id = a.id AND ac2.access_revoked_at IS NULL),
      '[]'::JSONB
    )                 AS members,
    latest.message    AS last_message,
    latest.created_at AS last_message_at,
    COALESCE(unread.cnt, 0) AS unread_count
  FROM accounts a
  JOIN multi_contact_accounts mca ON mca.account_id = a.id
  JOIN LATERAL (
    SELECT pm.message, pm.created_at FROM portal_messages pm
    WHERE pm.deleted_at IS NULL AND pm.account_id = a.id
    ORDER BY pm.created_at DESC LIMIT 1
  ) latest ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt FROM portal_messages pm
    WHERE pm.deleted_at IS NULL AND pm.sender_type = 'client'
      AND pm.read_at IS NULL AND pm.account_id = a.id
  ) unread ON TRUE

  UNION ALL

  -- Branch 2: one contact-level thread per contact with ≥1 VISIBLE message.
  -- Visible for contact c = messages NOT owned by a multi-member account:
  --   (a) tagged to c AND (personal-NULL OR on a non-multi-member account)
  --   (b) company-only rows (contact_id NULL) on c's linked NON-multi-member
  --       accounts (solo-company system notes / legacy admin sends).
  -- For contacts with no multi-member membership the predicate reduces to the
  -- historical superset — solo-owner threads are byte-identical to before.
  SELECT
    c.id              AS contact_id,
    c.full_name       AS contact_name,
    NULL::UUID        AS account_id,
    COALESCE(
      (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('id', a2.id, 'name', a2.company_name) ORDER BY a2.company_name)
       FROM accounts a2 JOIN account_contacts ac3 ON ac3.account_id = a2.id
       WHERE ac3.contact_id = c.id
         AND ac3.access_revoked_at IS NULL
         AND a2.id NOT IN (SELECT account_id FROM multi_contact_accounts)),
      '[]'::JSONB
    )                 AS companies,
    '[]'::JSONB       AS members,
    latest.message    AS last_message,
    latest.created_at AS last_message_at,
    COALESCE(unread.cnt, 0) AS unread_count
  FROM contacts c
  JOIN LATERAL (
    SELECT pm.message, pm.created_at FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND (
        (pm.contact_id = c.id AND (
          pm.account_id IS NULL
          OR pm.account_id NOT IN (SELECT account_id FROM multi_contact_accounts)
        ))
        OR (pm.contact_id IS NULL AND pm.account_id IN (
          SELECT ac4.account_id FROM account_contacts ac4
          WHERE ac4.contact_id = c.id
            AND ac4.access_revoked_at IS NULL
            AND ac4.account_id NOT IN (SELECT account_id FROM multi_contact_accounts)
        ))
      )
    ORDER BY pm.created_at DESC LIMIT 1
  ) latest ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt FROM portal_messages pm
    WHERE pm.deleted_at IS NULL AND pm.sender_type = 'client'
      AND pm.read_at IS NULL
      AND (
        (pm.contact_id = c.id AND (
          pm.account_id IS NULL
          OR pm.account_id NOT IN (SELECT account_id FROM multi_contact_accounts)
        ))
        OR (pm.contact_id IS NULL AND pm.account_id IN (
          SELECT ac5.account_id FROM account_contacts ac5
          WHERE ac5.contact_id = c.id
            AND ac5.access_revoked_at IS NULL
            AND ac5.account_id NOT IN (SELECT account_id FROM multi_contact_accounts)
        ))
      )
  ) unread ON TRUE

  ORDER BY last_message_at DESC NULLS LAST
  LIMIT 500;
$function$;

-- 5. Staff list of thread keys (production definition + "access_revoked_at IS NULL" wherever a link is read).
CREATE OR REPLACE FUNCTION public.get_portal_chat_people_thread_keys()
 RETURNS TABLE(contact_id uuid, account_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH multi_contact_accounts AS (
    SELECT ac.account_id
    FROM account_contacts ac
    WHERE ac.account_id IS NOT NULL
      AND ac.access_revoked_at IS NULL
    GROUP BY ac.account_id
    HAVING COUNT(DISTINCT ac.contact_id) > 1
  ),
  people AS (
    SELECT DISTINCT pm.contact_id AS p_contact_id, pm.account_id AS p_account_id
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND pm.sender_type IN ('client', 'admin')
  )

  SELECT NULL::uuid AS contact_id, a.id AS account_id
  FROM accounts a
  WHERE a.id IN (SELECT mca.account_id FROM multi_contact_accounts mca)
    AND a.id IN (SELECT p.p_account_id FROM people p WHERE p.p_account_id IS NOT NULL)

  UNION

  SELECT c.id AS contact_id, NULL::uuid AS account_id
  FROM contacts c
  WHERE c.id IN (
    SELECT p.p_contact_id FROM people p
    WHERE p.p_contact_id IS NOT NULL
      AND (p.p_account_id IS NULL
           OR p.p_account_id NOT IN (SELECT mca.account_id FROM multi_contact_accounts mca))
  )

  UNION

  SELECT ac.contact_id AS contact_id, NULL::uuid AS account_id
  FROM account_contacts ac
  JOIN contacts c2 ON c2.id = ac.contact_id
  WHERE ac.access_revoked_at IS NULL
    AND ac.account_id IN (
    SELECT p.p_account_id FROM people p
    WHERE p.p_contact_id IS NULL
      AND p.p_account_id IS NOT NULL
      AND p.p_account_id NOT IN (SELECT mca.account_id FROM multi_contact_accounts mca)
  );
$function$;
