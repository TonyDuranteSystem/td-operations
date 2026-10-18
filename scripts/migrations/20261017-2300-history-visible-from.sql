-- Storage check Phase 2, slice 3 (dev job d14e823f): a new owner sees a company's history only from a date.
-- account_contacts.history_visible_from: NULL = the person sees everything (every existing person, unchanged).
-- documents.visible_to_new_owners: staff can open ONE older document to a person whose view starts later.
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS history_visible_from timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS visible_to_new_owners boolean NOT NULL DEFAULT false;
