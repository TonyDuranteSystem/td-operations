-- Migration: portal chat — one message, one staff thread (MMLLC duplicate fix)
-- Applied to sandbox first per R105. Prod DDL run by Antonio in the Supabase
-- SQL editor before the code push (DDL-before-push, same as prior prod DDL).
--
-- WHY (2026-07-08, Adam Mihaly / LUMA Beauty Global LLC):
-- The live get_portal_chat_threads_v2 (which had DRIFTED from the repo file
-- 20260505-1600-unified-chat-threads.sql on BOTH prod and sandbox, and prod ≠
-- sandbox) emitted BOTH an account-level thread (multi-member LLC) AND a
-- contact-level thread for a member who had any personal-scope message. The
-- contact branch's latest/unread laterals used the unrestricted superset
-- `pm.contact_id = c.id`, so every company-scoped client message appeared in —
-- and bumped the unread badge of — BOTH threads. Staff saw every MMLLC client
-- message twice ("one as contact and one as company").
--
-- NEW RULE (Antonio, 2026-07-08): a message belongs to exactly ONE staff
-- thread — the one where the client wrote it.
--   * Company-scoped message (account_id set) on a MULTI-member account →
--     that account's thread ONLY.
--   * Personal message (account_id NULL) → the contact's thread ONLY.
--   * Solo-owned companies have NO account-level thread; their messages stay
--     in the owner's unified contact thread (unchanged, incl. company-only
--     rows with contact_id NULL).
--
-- Definition unified: "multi-member" is STRUCTURAL — an account with 2+
-- distinct linked contacts in account_contacts (sandbox already used this;
-- prod used historical-messages). Structure matches the business meaning
-- (MMLLC ⇒ company thread) and is stable as members are linked.
--
-- Emission: a contact row appears only if the contact has ≥1 visible message
-- under the new rule (the inner JOIN LATERAL drops empty threads), so a
-- MMLLC member with no personal/solo-company messages gets no empty row.
--
-- CLIENT-SIDE PRIVACY IS NOT TOUCHED: this function feeds the STAFF inbox
-- only. Client visibility rules live in lib/portal/chat-scope*.ts.

CREATE OR REPLACE FUNCTION get_portal_chat_threads_v2()
RETURNS TABLE (
  contact_id      UUID,
  contact_name    TEXT,
  account_id      UUID,
  companies       JSONB,
  members         JSONB,
  last_message    TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count    BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  -- Structural definition: 2+ distinct linked contacts = multi-member account.
  WITH multi_contact_accounts AS (
    SELECT ac.account_id
    FROM account_contacts ac
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
       FROM account_contacts ac2 JOIN contacts c ON c.id = ac2.contact_id WHERE ac2.account_id = a.id),
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
            AND ac5.account_id NOT IN (SELECT account_id FROM multi_contact_accounts)
        ))
      )
  ) unread ON TRUE

  ORDER BY last_message_at DESC NULLS LAST
  LIMIT 500;
$$;

COMMENT ON FUNCTION get_portal_chat_threads_v2 IS
  '2026-07-08 — One message, one staff thread. Multi-member accounts (2+ linked
   contacts, structural) own their company-scoped messages exclusively; contact
   threads carry only personal + solo-company messages. Fixes MMLLC messages
   appearing in both the company AND the member''s contact thread (Adam Mihaly /
   LUMA Beauty Global LLC, 2026-07-08). Supersedes the drifted live versions —
   source of truth: scripts/migrations/20260708-2000-portal-chat-one-thread-per-message.sql.';
