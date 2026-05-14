-- Contact request forms: two flows, one table.
--   form_type='add_new'         → owner fills form to add a NEW contact to the account
--   form_type='update_existing' → existing contact reviews/updates their own info
--
-- recipient_contact_id is who receives the form (always required).
-- target_contact_id is the contact being updated (only set for update_existing).

CREATE TABLE IF NOT EXISTS contact_request_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_contact_id uuid NOT NULL REFERENCES contacts(id),
  target_contact_id uuid REFERENCES contacts(id),
  form_type text NOT NULL CHECK (form_type IN ('add_new', 'update_existing')),
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(18), 'hex'),
  access_code text NOT NULL DEFAULT upper(encode(gen_random_bytes(4), 'hex')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'cancelled')),
  pre_populated_data jsonb,
  submitted_data jsonb,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_request_forms_account ON contact_request_forms(account_id);
CREATE INDEX IF NOT EXISTS idx_contact_request_forms_recipient ON contact_request_forms(recipient_contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_request_forms_target ON contact_request_forms(target_contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_request_forms_status ON contact_request_forms(status);

ALTER TABLE contact_request_forms ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; admins access via supabaseAdmin. No public policies.

-- Seed contact_roles catalog. Adding new roles is a one-click action on /catalog
-- in the CRM — no code change required.
INSERT INTO catalog_definitions (id, display_name, display_name_translations, description, admin_can_add_rows)
VALUES (
  'contact_roles',
  'Contact Roles',
  '{"it": "Ruoli Contatto"}'::jsonb,
  'Roles assignable to contacts within an account (Owner, Member, Administrative, Accountant, etc.). Used by the contact request forms.',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, status)
VALUES
  ('contact_roles', 'owner', 'Owner', '{"en": "Owner", "it": "Titolare"}'::jsonb, 'active'),
  ('contact_roles', 'member', 'Member', '{"en": "Member", "it": "Socio"}'::jsonb, 'active'),
  ('contact_roles', 'administrative', 'Administrative', '{"en": "Administrative", "it": "Amministrativo"}'::jsonb, 'active'),
  ('contact_roles', 'accountant', 'Accountant', '{"en": "Accountant", "it": "Commercialista"}'::jsonb, 'active'),
  ('contact_roles', 'authorized_representative', 'Authorized Representative', '{"en": "Authorized Representative", "it": "Rappresentante Autorizzato"}'::jsonb, 'active'),
  ('contact_roles', 'other', 'Other', '{"en": "Other", "it": "Altro"}'::jsonb, 'active')
ON CONFLICT (catalog_id, slug) DO NOTHING;
