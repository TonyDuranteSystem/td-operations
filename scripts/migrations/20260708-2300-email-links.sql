-- Email → client linking (Antonio 2026-07-08): attach any Gmail thread
-- (ShipStation shipment, Mercury payment notice, …) to a CRM client so it
-- shows in that client's email views (Portal Chats Email tab + account page
-- Emails tab) next to the auto-matched mail.
--
-- EXTENDS the existing `email_links` table (created for the inbox
-- create-from-email dialog: thread_id, account_id, service_delivery_id,
-- linked_by, created_at). NOTE: that dialog upserts with
-- onConflict:'thread_id' but NO unique index on thread_id ever existed, so
-- its link write has silently failed since day one (0 rows in production) —
-- the unique index below fixes that latent bug too. One link per thread:
-- re-linking replaces the client.

ALTER TABLE email_links ADD COLUMN IF NOT EXISTS mailbox text NOT NULL DEFAULT 'support';
ALTER TABLE email_links ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE email_links ADD COLUMN IF NOT EXISTS subject text;   -- display snapshot
ALTER TABLE email_links ADD COLUMN IF NOT EXISTS sender text;    -- display snapshot

-- Backs the existing create-from-email upsert AND the new Link-to-client API.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_links_thread ON email_links (thread_id);
CREATE INDEX IF NOT EXISTS idx_email_links_account ON email_links (account_id);
CREATE INDEX IF NOT EXISTS idx_email_links_contact ON email_links (contact_id);

-- Staff data, service-role access only.
ALTER TABLE email_links ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE email_links IS
  'Gmail-thread → CRM client links: inbox "Link to client" + create-from-email. One link per thread (uq_email_links_thread). Merged into client email views (client-emails endpoint). subject/sender are display snapshots.';
