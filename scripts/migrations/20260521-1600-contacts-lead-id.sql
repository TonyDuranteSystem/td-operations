-- Add originating-lead reference to contacts.
--
-- Why: when a formation/onboarding deal bundles ITIN, we start the ITIN for
-- each member at wizard submit — BEFORE the company is formed. A brand-new
-- member (e.g. Péter Nemeskéri) gets a contact created at that point with no
-- account yet. lead_id records WHICH lead/deal that contact was born from, so
-- a pre-company "floating" ITIN contact is always traceable.
--
-- Semantics (enforced in code, not DB): WRITE-ONCE at contact creation.
-- Never overwrite an existing contact's lead_id (existing-client members keep
-- their own origin). When the company later materializes, the contact is
-- linked to the account via account_contacts; lead_id remains as origin history.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

-- Index for "show me contacts that originated from this lead".
CREATE INDEX IF NOT EXISTS idx_contacts_lead_id ON contacts(lead_id) WHERE lead_id IS NOT NULL;
