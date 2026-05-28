-- Backfill: attach "loose" portal_messages (no account_id) to a company when the
-- contact belongs to exactly ONE company. Prep for per-company chat isolation —
-- so single-company clients' existing messages stay visible once chat is scoped
-- per company. Multi-company contacts are intentionally LEFT untouched (their
-- loose messages have no unambiguous company → they surface in the "Personal"
-- thread). Idempotent: re-running only affects still-null rows.
--
-- DML backfill (not DDL). Apply to sandbox first, then production after approval.

UPDATE portal_messages m
SET account_id = solo.account_id
FROM (
  SELECT contact_id, (array_agg(DISTINCT account_id))[1] AS account_id
  FROM account_contacts
  GROUP BY contact_id
  HAVING count(DISTINCT account_id) = 1
) solo
WHERE m.account_id IS NULL
  AND m.contact_id = solo.contact_id;
