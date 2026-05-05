-- Migration: unified portal chat threads (one per contact)
-- Applied to sandbox first per R105.
-- Replaces per-account thread grouping with per-contact grouping.
-- Each row merges messages from all companies linked to the contact.

CREATE OR REPLACE FUNCTION get_portal_chat_threads_unified()
RETURNS TABLE (
  contact_id   UUID,
  contact_name TEXT,
  companies    JSONB,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT
    c.id          AS contact_id,
    c.full_name   AS contact_name,
    COALESCE(
      (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT('id', a.id, 'name', a.company_name)
          ORDER BY a.company_name
        )
        FROM accounts a
        JOIN account_contacts ac ON ac.account_id = a.id
        WHERE ac.contact_id = c.id
      ),
      '[]'::JSONB
    ) AS companies,
    latest.message       AS last_message,
    latest.created_at    AS last_message_at,
    COALESCE(unread.cnt, 0) AS unread_count

  FROM contacts c

  -- Only contacts that have at least one message (across any scope)
  JOIN LATERAL (
    SELECT pm.message, pm.created_at
    FROM portal_messages pm
    WHERE pm.deleted_at IS NULL
      AND (
        pm.contact_id = c.id
        OR (
          pm.contact_id IS NULL
          AND pm.account_id IN (
            SELECT ac2.account_id FROM account_contacts ac2 WHERE ac2.contact_id = c.id
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
            SELECT ac3.account_id FROM account_contacts ac3 WHERE ac3.contact_id = c.id
          )
        )
      )
  ) unread ON TRUE

  ORDER BY latest.created_at DESC NULLS LAST
  LIMIT 500;
$$;
