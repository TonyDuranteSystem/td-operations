-- Email → client links, all roles (Antonio 2026-07-08): the inbox
-- "Link to client" must also target LEADS and PARTNERS, not just
-- accounts/contacts. Additive follow-up to 20260708-2300-email-links.sql.

ALTER TABLE email_links ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE email_links ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES client_partners(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_email_links_lead ON email_links (lead_id);
CREATE INDEX IF NOT EXISTS idx_email_links_partner ON email_links (partner_id);
