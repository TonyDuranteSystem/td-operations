-- migration:20260527-1550-contact-merge-and-alt-emails.sql
--
-- Foundation for two coupled features:
--   (#3) secondary "matching" emails on a contact, and
--   (#2) a reversible, FK-driven contact merge.
--
--   • contacts.alt_emails  — extra emails used ONLY to recognise the same person
--     at find-or-create time. Login / primary identity stays on contacts.email;
--     alt_emails never authenticate. Lower-cased on write by callers.
--   • contacts.merged_into — when a duplicate is merged away, points at the
--     surviving contact. Merged rows are filtered out of contact lists/search.
--   • contact_merge_log    — one row per merge: a full snapshot (loser row + every
--     reassigned row) plus the per-table reassignment counts, for audit + rollback.
--
-- Idempotent.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS alt_emails text[] NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES contacts(id);

CREATE INDEX IF NOT EXISTS idx_contacts_alt_emails ON contacts USING gin (alt_emails);
CREATE INDEX IF NOT EXISTS idx_contacts_merged_into ON contacts (merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_merge_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loser_id     uuid NOT NULL,
  winner_id    uuid NOT NULL,
  merged_by    text,
  reassignment jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"table.column": count} of rows moved
  snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- loser contact row + moved rows, for rollback
  reverted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
