-- ============================================================================
-- Dev job 93580372-5b1b-46cc-ab8d-0af82483e2ee (bug: Calendly booking webhook
-- creates a stray lead even when the booker is already an existing client).
--
-- Adds a NEW, dedicated column. Deliberately NOT reusing leads.converted_to_contact_id
-- — that column is read by several other flows (service activation, formation,
-- tax-return intake, onboarding-setup) as "the lead that actually converted into
-- this contact", and several of them resolve/join on it expecting at most one
-- real match. Tagging a throwaway "booked a call" lead with that same column
-- would let it masquerade as someone's real conversion record and could make
-- those flows pick the wrong lead. This column is read ONLY by the Calendly
-- webhook (writer) and the diagnose-contact/diagnose-account "Lead status"
-- check (reader) — nothing else.
--
-- Fully additive and safe to run ahead of the code deploy: the column is
-- nullable, has no default, and nothing reads it until the new code ships.
-- ============================================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS existing_client_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN leads.existing_client_contact_id IS
  'Set only by the Calendly booking webhook when the booking email matched an already-established contact (not a fresh prospect) — marks this lead as a booking record, not an open sales opportunity, so diagnose-contact/diagnose-account stop flagging it as unconverted. NEVER the same thing as converted_to_contact_id (the real conversion record) — do not conflate.';
