-- Portal Chats — "Addressed to" member label (dev job 08a8be62)
--
-- Antonio asked for a way to say WHICH member of a multi-member company a
-- staff message is addressed to. Council review (full 7-reviewer pass, then
-- a dedicated 3-reviewer re-check) found this must be a SEPARATE, isolated
-- field from portal_messages.contact_id — that column is already wired into
-- decideAdminSendScope's leak-prevention gate (lib/portal/admin-send-scope.ts,
-- born from the 2026-08-07 cross-company leak), which verifies a contact via
-- account_contacts only. Company-type members (and any member whose
-- account_contacts mirror is missing) would be wrongly rejected if routed
-- through that gate. Since Antonio confirmed this is a LABEL, not a privacy
-- boundary (2026-09-04 decision), it is deliberately kept OUT of that
-- contract entirely: addressed_to_contact_id never gates access, is never
-- read by decideAdminSendScope/isContactLinkedToAccount, and does not change
-- who can see the message (still governed purely by account_id/contact_id/
-- sender_context as today).
--
-- Nullable, no backfill — only new messages get labeled, same precedent as
-- sender_context (20260505-0145).

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS addressed_to_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN portal_messages.addressed_to_contact_id IS
  'Optional staff-set label (2026-09-04): which member of a multi-member company this company-scoped message is addressed to. Display/attribution metadata ONLY. Deliberately NOT part of the sender_context/account_id visibility contract in lib/portal/admin-send-scope.ts -- the message stays visible to the whole company thread regardless of this value. Resolved via lib/portal/addressed-to.ts against the real `members` table, not account_contacts.';
