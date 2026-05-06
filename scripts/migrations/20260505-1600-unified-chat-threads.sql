-- Migration: unified portal chat threads (one per contact, or one per account for multi-member LLCs)
-- DROP required because return type changed (added account_id + members columns).
DROP FUNCTION IF EXISTS get_portal_chat_threads_unified();
-- Applied to sandbox first per R105.
-- v2 (2026-05-06): adds account_id + members columns.
--   Multi-contact accounts (≥2 contacts with messages on same account) get ONE account-level
--   row instead of N contact rows. All other contacts keep per-contact rows.

CREATE OR REPLACE FUNCTION get_portal_chat_threads_unified()
RETURNS TABLE (
  contact_id      UUID,
  contact_name    TEXT,
  account_id      UUID,     -- non-null for account-level (multi-member LLC) threads
  companies       JSONB,    -- [{id,name}] for contact-level threads; [] for account-level
  members         JSONB,    -- [{id,name}] member contacts for account-level threads; [] otherwise
  last_message    TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count    BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  -- Accounts where 2+ distinct contacts each have portal messages under that account
  WITH multi_contact_accounts AS (
    SELECT pm.account_id
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND pm.contact_id IS NOT NULL
      AND pm.account_id IS NOT NULL
    GROUP BY pm.account_id
    HAVING COUNT(DISTINCT pm.contact_id) > 1
  ),

  -- Contacts that are fully covered by an account-level thread
  covered_contacts AS (
    SELECT DISTINCT ac.contact_id
    FROM account_contacts ac
    WHERE ac.account_id IN (SELECT account_id FROM multi_contact_accounts)
  )

  -- PART A: one row per multi-contact account
  SELECT
    NULL::UUID        AS contact_id,
    a.company_name    AS contact_name,
    a.id              AS account_id,
    '[]'::JSONB       AS companies,
    COALESCE(
      (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT('id', c.id, 'name', c.full_name)
          ORDER BY c.full_name
        )
        FROM account_contacts ac2
        JOIN contacts c ON c.id = ac2.contact_id
        WHERE ac2.account_id = a.id
      ),
      '[]'::JSONB
    )                 AS members,
    latest.message    AS last_message,
    latest.created_at AS last_message_at,
    COALESCE(unread.cnt, 0) AS unread_count

  FROM accounts a
  JOIN multi_contact_accounts mca ON mca.account_id = a.id

  JOIN LATERAL (
    SELECT pm.message, pm.created_at
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND pm.account_id = a.id
    ORDER BY pm.created_at DESC
    LIMIT 1
  ) latest ON TRUE

  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND pm.sender_type = 'client'
      AND pm.read_at IS NULL
      AND pm.account_id = a.id
  ) unread ON TRUE

  UNION ALL

  -- PART B: per-contact rows, excluding contacts already in an account-level thread
  SELECT
    c.id          AS contact_id,
    c.full_name   AS contact_name,
    NULL::UUID    AS account_id,
    COALESCE(
      (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT('id', a2.id, 'name', a2.company_name)
          ORDER BY a2.company_name
        )
        FROM accounts a2
        JOIN account_contacts ac3 ON ac3.account_id = a2.id
        WHERE ac3.contact_id = c.id
      ),
      '[]'::JSONB
    )             AS companies,
    '[]'::JSONB   AS members,
    latest.message       AS last_message,
    latest.created_at    AS last_message_at,
    COALESCE(unread.cnt, 0) AS unread_count

  FROM (
    SELECT c.* FROM contacts c
    WHERE NOT EXISTS (
      SELECT 1 FROM covered_contacts cc WHERE cc.contact_id = c.id
    )
  ) c

  JOIN LATERAL (
    SELECT pm.message, pm.created_at
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND (
        pm.contact_id = c.id
        OR (
          pm.contact_id IS NULL
          AND pm.account_id IN (
            SELECT ac4.account_id FROM account_contacts ac4 WHERE ac4.contact_id = c.id
          )
        )
      )
    ORDER BY pm.created_at DESC
    LIMIT 1
  ) latest ON TRUE

  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND pm.sender_type = 'client'
      AND pm.read_at IS NULL
      AND (
        pm.contact_id = c.id
        OR (
          pm.contact_id IS NULL
          AND pm.account_id IN (
            SELECT ac5.account_id FROM account_contacts ac5 WHERE ac5.contact_id = c.id
          )
        )
      )
  ) unread ON TRUE

  ORDER BY last_message_at DESC NULLS LAST
  LIMIT 500;
$$;
