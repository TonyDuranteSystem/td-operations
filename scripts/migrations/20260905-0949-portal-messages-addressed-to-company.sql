ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS addressed_to_company BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE portal_messages
  ADD CONSTRAINT portal_messages_addressed_to_exclusive
  CHECK (NOT (addressed_to_company AND addressed_to_contact_id IS NOT NULL));

COMMENT ON COLUMN portal_messages.addressed_to_company IS
  'True when staff explicitly marked this message as addressed to the whole company, as
  opposed to one specific member (addressed_to_contact_id) or nobody having set anything at
  all (both this and addressed_to_contact_id stay at their defaults). Added 2026-09-05, dev
  job 08a8be62, after Antonio found the "Addressed to" picker in a multi-member LLC thread
  only ever offered individual members, with no way to explicitly say "the whole company" --
  the closest thing was an unset default that looked identical to a message nobody had
  bothered to label. Mutually exclusive with addressed_to_contact_id via
  portal_messages_addressed_to_exclusive -- enforced at the database level, not just in the
  application, so a bug in the write path cannot produce a message that is somehow both.';
