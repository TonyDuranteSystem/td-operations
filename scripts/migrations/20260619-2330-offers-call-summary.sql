-- Add client-facing "call summary" to offers.
--
-- The Create Offer AI generator (app/api/crm/admin-actions/generate-offer-narrative)
-- now produces a detailed recap of the client consultation call. It renders on
-- the client-facing offer pages (app/offer/[token]/page.tsx and [code]/page.tsx)
-- as the "Summary of Our Call" / "Riepilogo della Nostra Call" section.
--
-- Nullable text, no default: offers created before this column existed, and
-- offers with no call notes at generation time, simply have no call summary
-- and the section is hidden.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS call_summary text;

COMMENT ON COLUMN offers.call_summary IS
  'Client-facing recap of the consultation call, AI-generated at offer creation and editable by staff. Rendered on the offer page. Null/empty = no call summary shown.';
