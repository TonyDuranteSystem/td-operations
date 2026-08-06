-- WS-D (dev job c0a61e44, architect-approved DDL): ambiguity marker for call
-- linking. When a Circleback call's attendees match MORE than one distinct
-- client identity (or none cleanly), the webhook links NOTHING and records why
-- here — a wrong link files a call transcript on the wrong client, which is
-- worse than an unlinked call. Staff resolve via the existing manual link UI;
-- the marker is cleared on manual link.

ALTER TABLE call_summaries ADD COLUMN IF NOT EXISTS link_review text;

COMMENT ON COLUMN call_summaries.link_review IS
  'Why auto-linking was refused (e.g. "2 distinct client identities matched: …"). NULL = no review needed. Cleared when staff link manually.';
