-- ============================================================
-- TD Operations - Sandbox Schema
-- Source: production PostgREST OpenAPI + lib/database.types.ts
-- Tables: 120 | Enums: 26 | FKs: 177
-- Views (excluded): v_account_detail, v_active_service_deliveries, v_active_tasks, v_client_full, v_client_timeline, v_messaging_inbox, v_new_messages, v_overdue_payments, v_pipeline_summary, v_sd_pipeline_summary, v_sla_monitor, v_sla_summary, v_tax_return_tracker
-- Apply: ./apply-schema.sh <sandbox-db-password>
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Enum Types
DO $$ BEGIN
  CREATE TYPE public.account_status AS ENUM ('Active', 'Pending Formation', 'Delinquent', 'Suspended', 'Offboarding', 'Cancelled', 'Closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.billing_type AS ENUM ('Included', 'Standalone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.company_type AS ENUM ('Single Member LLC', 'Multi Member LLC', 'C-Corp Elected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.conversation_channel AS ENUM ('WhatsApp', 'Telegram', 'Email', 'Phone', 'Portal', 'In-Person', 'Calendly', 'Zoom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.conversation_status AS ENUM ('New', 'Proposed', 'Approved', 'Sent', 'Archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.currency AS ENUM ('USD', 'EUR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.deal_stage AS ENUM ('Initial Consultation', 'Offer Sent', 'Negotiation', 'Agreement Signed', 'Paid', 'Closed Won', 'Closed Lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.dev_task_priority AS ENUM ('critical', 'high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.dev_task_status AS ENUM ('backlog', 'todo', 'in_progress', 'blocked', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.dev_task_type AS ENUM ('feature', 'bugfix', 'refactor', 'cleanup', 'docs', 'infra');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.email_queue_status AS ENUM ('Draft', 'Queued', 'Sent', 'Failed', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.india_status AS ENUM ('Not Sent', 'Sent - Pending', 'In Progress', 'Completed', 'Filed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.interaction_type AS ENUM ('Email Inbound', 'Email Outbound', 'WhatsApp Inbound', 'WhatsApp Outbound', 'Telegram Inbound', 'Telegram Outbound', 'Phone Call', 'Portal Message', 'Meeting', 'Note');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.lead_status AS ENUM ('New', 'Call Scheduled', 'Call Done', 'Offer Sent', 'Negotiating', 'Paid', 'Converted', 'Lost', 'Suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.offer_status AS ENUM ('Sent', 'Accepted', 'Rejected', 'Expired', 'Negotiating', 'Draft', 'Viewed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.partner_type AS ENUM ('Reseller', 'Referral', 'Affiliate', 'Service Partner', 'RA Provider', 'Banking Partner', 'External Partner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_period AS ENUM ('January', 'June', 'One-Time', 'Custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_status AS ENUM ('Pending', 'Paid', 'Overdue', 'Delinquent', 'Waived', 'Refunded', 'Not Invoiced', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.service_status AS ENUM ('Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party', 'Completed', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.service_type AS ENUM ('Company Formation', 'Client Onboarding', 'Tax Return', 'State RA Renewal', 'CMRA', 'Shipping', 'Public Notary', 'Banking Fintech', 'Banking Physical', 'ITIN', 'Company Closure', 'Client Offboarding', 'State Annual Report', 'EIN Application', 'Support');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.sync_direction AS ENUM ('to_hubspot', 'from_hubspot', 'bidirectional');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.task_category AS ENUM ('Client Response', 'Document', 'Filing', 'Follow-up', 'Payment', 'CRM Update', 'Internal', 'KYC', 'Shipping', 'Notarization', 'Client Communication', 'Formation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.task_priority AS ENUM ('Urgent', 'High', 'Normal', 'Low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.task_status AS ENUM ('To Do', 'In Progress', 'Waiting', 'Done', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.tax_return_status AS ENUM ('Payment Pending', 'Link Sent - Awaiting Data', 'Data Received', 'Sent to India', 'Extension Filed', 'TR Completed - Awaiting Signature', 'TR Filed', 'Paid - Not Started', 'Activated - Need Link', 'Not Invoiced', 'Extension Requested');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.tax_return_type AS ENUM ('SMLLC', 'MMLLC', 'Corp', 'LSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables
CREATE TABLE IF NOT EXISTS public.account_contacts (
  account_id uuid,
  contact_id uuid,
  role text DEFAULT Member,
  ownership_pct numeric,
  CONSTRAINT account_contacts_pkey PRIMARY KEY (account_id, contact_id)
);

CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  entity_type public.company_type,
  status public.account_status DEFAULT Pending Formation,
  ein_number text,
  filing_id text,
  formation_date date,
  state_of_formation text DEFAULT Florida,
  physical_address text,
  registered_agent_address text,
  ra_renewal_date date,
  portal_account boolean DEFAULT False,
  portal_created_date date,
  services_bundle text[],
  installment_1_amount numeric,
  installment_2_amount numeric,
  installment_1_currency public.currency DEFAULT USD,
  installment_2_currency public.currency DEFAULT USD,
  cancellation_requested boolean DEFAULT False,
  cancellation_date date,
  referrer text,
  lead_source text,
  referred_by uuid,
  referral_commission_pct numeric DEFAULT 10.0,
  referral_status text,
  gdrive_folder_url text,
  notes text,
  airtable_id text,
  zoho_account_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  kb_folder_path text,
  client_health text,
  cmra_amount numeric,
  registered_agent_provider text,
  annual_report_due_date date,
  qb_customer_id text,
  drive_folder_id text,
  account_type text DEFAULT Client,
  welcome_package_status text,
  invoice_logo_url text,
  bank_details jsonb,
  payment_gateway text,
  payment_link text,
  cmra_renewal_date date,
  portal_tier text DEFAULT active,
  portal_auto_created boolean DEFAULT False,
  is_test boolean DEFAULT False,
  hc_company_id text,
  dunning_reminder_1_days integer DEFAULT 7,
  dunning_reminder_2_days integer DEFAULT 14,
  dunning_escalation_email text,
  dunning_pause boolean DEFAULT False,
  partner_id uuid,
  communication_email text,
  setup_fee_amount numeric,
  setup_fee_currency public.currency,
  setup_fee_paid_date date,
  CONSTRAINT accounts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.action_log (
  id uuid DEFAULT gen_random_uuid(),
  actor text NOT NULL DEFAULT claude.ai,
  action_type text NOT NULL,
  table_name text NOT NULL,
  record_id text,
  account_id uuid,
  summary text NOT NULL,
  details jsonb,
  session_checkpoint_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  contact_id uuid,
  CONSTRAINT action_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.admin_push_subscriptions (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email text NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT admin_push_subscriptions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.agent_decisions (
  id uuid DEFAULT gen_random_uuid(),
  situation text NOT NULL,
  action_taken text NOT NULL,
  tools_used text[],
  account_id uuid,
  contact_id uuid,
  task_id uuid,
  approved boolean,
  approved_by text,
  outcome text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT agent_decisions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_delegations (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  task text NOT NULL,
  repo text DEFAULT td-operations,
  analysis jsonb,
  status text DEFAULT analyzing,
  branch_name text,
  pr_url text,
  pr_number integer,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT ai_delegations_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_embeddings (
  id uuid DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  chunk_text text NOT NULL,
  chunk_index integer,
  embedding vector(512),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_embeddings_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_facts (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_session_id uuid,
  category text NOT NULL,
  content text NOT NULL,
  reasoning text,
  status text DEFAULT active,
  superseded_by uuid,
  embedding vector(512),
  created_at timestamp with time zone DEFAULT now(),
  superseded_at timestamp with time zone,
  CONSTRAINT ai_facts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_messages (
  id uuid DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  tool_calls jsonb,
  tool_results jsonb,
  model text,
  tokens_input integer,
  tokens_output integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_messages_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_notifications (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb,
  priority text DEFAULT normal,
  channel text DEFAULT push,
  status text DEFAULT pending,
  dedup_key text,
  dedup_window interval DEFAULT 24:00:00,
  source text,
  created_at timestamp with time zone DEFAULT now(),
  pushed_at timestamp with time zone,
  read_at timestamp with time zone,
  CONSTRAINT ai_notifications_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_sessions (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text,
  model text DEFAULT claude-sonnet-4-6,
  message_count integer DEFAULT 0,
  summary text,
  created_at timestamp with time zone DEFAULT now(),
  ended_at timestamp with time zone,
  is_active boolean DEFAULT True,
  deleted_at timestamp with time zone,
  metadata jsonb,
  CONSTRAINT ai_sessions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ai_user_context (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  context_text text NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_user_context_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.airtable_migration_log (
  id uuid DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  airtable_record_id text NOT NULL,
  supabase_id uuid,
  status text DEFAULT Pending,
  error_message text,
  migrated_at timestamp with time zone,
  CONSTRAINT airtable_migration_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.app_settings (
  key text,
  value jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT app_settings_pkey PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS public.approved_responses (
  id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text,
  tags text[],
  service_type public.service_type,
  language text DEFAULT English,
  response_text text NOT NULL,
  usage_count integer DEFAULT 0,
  last_used_date date,
  notes text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT approved_responses_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  tax_year integer NOT NULL,
  transaction_date date NOT NULL,
  description text,
  category text,
  subcategory text,
  counterparty text,
  amount numeric NOT NULL,
  currency text DEFAULT EUR,
  balance_after numeric,
  bank_name text,
  account_type text,
  transaction_ref text,
  source_file_id text,
  is_related_party boolean DEFAULT False,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT bank_transactions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.banking_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  account_id uuid,
  contact_id uuid,
  language text NOT NULL DEFAULT en,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  upload_paths text[],
  status text NOT NULL DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  provider text NOT NULL DEFAULT payset,
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT banking_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.billing_entities (
  id uuid DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL,
  account_id uuid,
  entity_name text NOT NULL,
  entity_type text,
  qb_customer_id text,
  currency text DEFAULT EUR,
  country text DEFAULT Italy,
  vat_number text,
  fiscal_code text,
  billing_address text,
  is_default boolean DEFAULT True,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT billing_entities_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.call_summaries (
  id uuid DEFAULT gen_random_uuid(),
  circleback_id text,
  meeting_name text,
  duration_seconds integer,
  meeting_url text,
  recording_url text,
  attendees jsonb,
  notes text,
  action_items jsonb,
  transcript jsonb,
  tags text[],
  ical_uid text,
  lead_id uuid,
  account_id uuid,
  raw_payload jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  contact_id uuid,
  CONSTRAINT call_summaries_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_bank_accounts (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  label text NOT NULL,
  currency text NOT NULL,
  account_holder text,
  bank_name text,
  iban text,
  swift_bic text,
  account_number text,
  routing_number text,
  notes text,
  show_on_invoice boolean NOT NULL DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_bank_accounts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_correspondence (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  file_name text NOT NULL,
  drive_file_id text,
  drive_file_url text,
  description text,
  read_at timestamp with time zone,
  uploaded_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_correspondence_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_credit_notes (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  credit_note_number text NOT NULL,
  original_invoice_id uuid NOT NULL,
  applied_to_invoice_id uuid,
  amount numeric NOT NULL,
  reason text,
  status text DEFAULT issued,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_credit_notes_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_customers (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  name text NOT NULL,
  email text,
  address text,
  vat_number text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  first_name text,
  last_name text,
  company_name text,
  phone text,
  city text,
  region text,
  country text,
  contact_id uuid,
  CONSTRAINT client_customers_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_expense_items (
  id uuid DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric DEFAULT 1,
  unit_price numeric DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  sort_order integer DEFAULT 0,
  CONSTRAINT client_expense_items_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_expenses (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  vendor_name text NOT NULL,
  vendor_id uuid,
  invoice_number text,
  internal_ref text,
  description text,
  currency text NOT NULL DEFAULT USD,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  issue_date date,
  due_date date,
  paid_date date,
  status text NOT NULL DEFAULT Pending,
  source text NOT NULL,
  td_payment_id uuid,
  attachment_url text,
  attachment_name text,
  attachment_storage_path text,
  ocr_extracted boolean DEFAULT False,
  ocr_raw_text text,
  ocr_confidence text,
  category text DEFAULT General,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  contact_id uuid,
  CONSTRAINT client_expenses_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_interactions (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  lead_id uuid,
  interaction_type public.interaction_type NOT NULL,
  direction text,
  subject text,
  body text,
  snippet text,
  gmail_message_id text,
  gmail_thread_id text,
  from_email text,
  to_email text[],
  cc_email text[],
  labels text[],
  attachments jsonb,
  matched_by text,
  matched_at timestamp with time zone,
  channel public.conversation_channel,
  handled_by text,
  notes text,
  interaction_date timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_interactions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_invoice_documents (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  sales_invoice_id uuid,
  expense_id uuid,
  direction text NOT NULL,
  invoice_number text NOT NULL,
  counterparty_name text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT USD,
  issue_date date,
  file_url text,
  file_name text,
  storage_path text,
  drive_file_id text,
  year integer NOT NULL,
  month integer NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_invoice_documents_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_invoice_items (
  id uuid DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric DEFAULT 1,
  unit_price numeric NOT NULL,
  amount numeric NOT NULL,
  sort_order integer DEFAULT 0,
  tax_rate numeric DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  CONSTRAINT client_invoice_items_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_invoice_templates (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  name text NOT NULL,
  customer_id uuid,
  currency text NOT NULL DEFAULT USD,
  items jsonb NOT NULL,
  message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_invoice_templates_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_invoices (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  customer_id uuid NOT NULL,
  invoice_number text NOT NULL,
  status text DEFAULT Draft,
  currency text DEFAULT USD,
  subtotal numeric DEFAULT 0,
  discount numeric DEFAULT 0,
  total numeric DEFAULT 0,
  issue_date date DEFAULT CURRENT_DATE,
  due_date date,
  paid_date date,
  notes text,
  message text,
  recurring_frequency text,
  recurring_next_date date,
  recurring_end_date date,
  recurring_parent_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  bank_account_id uuid,
  contact_id uuid,
  whop_checkout_url text,
  whop_plan_id text,
  amount_paid numeric DEFAULT 0,
  amount_due numeric,
  parent_invoice_id uuid,
  tax_total numeric DEFAULT 0,
  source text DEFAULT client,
  CONSTRAINT client_invoices_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_partners (
  id uuid DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL,
  partner_name text NOT NULL,
  partner_email text,
  status text DEFAULT active,
  commission_model text,
  price_list jsonb,
  agreed_services text[],
  notes text,
  is_test boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_partners_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.client_vendors (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  vat_number text,
  address text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  phone text,
  contact_person text,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_vendors_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.closure_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  lead_id uuid,
  contact_id uuid,
  account_id uuid,
  language text NOT NULL DEFAULT it,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  upload_paths text[],
  status text NOT NULL DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT closure_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.company_info_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  lead_id uuid,
  contact_id uuid,
  account_id uuid,
  entity_type text NOT NULL DEFAULT SMLLC,
  state text NOT NULL DEFAULT NM,
  language text NOT NULL DEFAULT en,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  upload_paths text[],
  status text NOT NULL DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT company_info_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.compliance_requirements (
  id integer,
  entity_type text NOT NULL,
  document_type_name text NOT NULL,
  category integer NOT NULL,
  is_required boolean DEFAULT True,
  description text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT compliance_requirements_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  first_name text,
  last_name text,
  email text,
  email_2 text,
  phone text,
  language text DEFAULT English,
  preferred_channel public.conversation_channel DEFAULT WhatsApp,
  citizenship text,
  residency text,
  itin_number text,
  itin_issue_date date,
  passport_on_file boolean DEFAULT False,
  kyc_status text,
  gdrive_folder_url text,
  notes text,
  airtable_id text,
  zoho_contact_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  phone_2 text,
  itin_renewal_date date,
  status text DEFAULT active,
  date_of_birth date,
  passport_expiry_date date,
  passport_number text,
  qb_customer_id text,
  portal_tier text,
  is_test boolean DEFAULT False,
  gender text,
  portal_email_sent_at timestamp with time zone,
  portal_email_template text,
  portal_role text DEFAULT client,
  referrer_type text,
  referral_code text,
  drive_folder_id text,
  primary_company_id uuid,
  address_line1 text,
  address_city text,
  address_state text,
  address_zip text,
  address_country text,
  CONSTRAINT contacts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.contracts (
  id uuid DEFAULT gen_random_uuid(),
  offer_token text NOT NULL,
  client_name text NOT NULL,
  client_email text,
  client_phone text,
  client_address text,
  client_city text,
  client_state text,
  client_zip text,
  client_country text,
  client_nationality text,
  client_passport text,
  client_passport_exp text,
  llc_type text,
  annual_fee text,
  contract_year text,
  installments text,
  signed_at timestamp with time zone,
  signed_ip text,
  pdf_path text,
  status text DEFAULT pending,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  wire_receipt_path text,
  payment_verified boolean DEFAULT False,
  selected_services jsonb,
  CONSTRAINT contracts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  deal_id uuid,
  date timestamp with time zone DEFAULT now(),
  channel public.conversation_channel,
  topic text,
  category text,
  client_message text,
  response_sent text,
  response_language text,
  status public.conversation_status DEFAULT New,
  template_used uuid,
  internal_notes text,
  fireflies_link text,
  direction text,
  handled_by text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT conversations_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.cron_log (
  id uuid DEFAULT gen_random_uuid(),
  endpoint text NOT NULL,
  status text NOT NULL,
  duration_ms integer,
  error_message text,
  details jsonb,
  executed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT cron_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.dashboard_project (
  id uuid DEFAULT gen_random_uuid(),
  phase text NOT NULL,
  step text NOT NULL,
  step_order integer NOT NULL,
  status text DEFAULT todo,
  description text,
  files_new text[],
  files_edit text[],
  depends_on text,
  feature_flag text,
  commit_hash text,
  session_notes text,
  blocked_reason text,
  assigned_session text,
  created_at timestamp with time zone DEFAULT now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT dashboard_project_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.deadlines (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  deadline_type text NOT NULL,
  due_date date NOT NULL,
  filed_date date,
  status text DEFAULT Pending,
  state text,
  notes text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deadline_record text,
  year smallint,
  blocked_reason text,
  confirmation_number text,
  assigned_to text,
  llc_type text,
  CONSTRAINT deadlines_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.deals (
  id uuid DEFAULT gen_random_uuid(),
  deal_name text NOT NULL,
  account_id uuid,
  contact_id uuid,
  lead_id uuid,
  stage public.deal_stage DEFAULT Initial Consultation,
  amount numeric,
  amount_currency public.currency DEFAULT USD,
  close_date date,
  deal_type text,
  payment_status public.payment_status DEFAULT Pending,
  pipeline text DEFAULT default,
  notes text,
  airtable_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deal_category text DEFAULT deal,
  service_type text,
  CONSTRAINT deals_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.deploy_smoke_results (
  id uuid DEFAULT gen_random_uuid(),
  commit_sha text NOT NULL,
  workflow_run_url text,
  checks jsonb NOT NULL,
  any_failed boolean NOT NULL,
  failure_count integer NOT NULL DEFAULT 0,
  checked_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deploy_smoke_results_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.dev_tasks (
  id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  type public.dev_task_type NOT NULL DEFAULT feature,
  status public.dev_task_status NOT NULL DEFAULT backlog,
  priority public.dev_task_priority NOT NULL DEFAULT medium,
  decisions text,
  progress_log text,
  blockers text,
  related_files text[],
  parent_task_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  CONSTRAINT dev_tasks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.document_types (
  id integer,
  type_name text NOT NULL,
  category integer NOT NULL,
  category_name text NOT NULL,
  suggested_folder text,
  description text,
  is_active boolean DEFAULT True,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT document_types_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid DEFAULT gen_random_uuid(),
  drive_file_id text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size bigint,
  drive_link text,
  drive_parent_folder_id text,
  document_type_id integer,
  document_type_name text,
  category integer,
  category_name text,
  confidence text,
  ocr_text text,
  ocr_page_count integer,
  ocr_confidence double precision,
  account_id uuid,
  account_name text,
  processed_at timestamp with time zone,
  status text DEFAULT pending,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  tax_year integer,
  contact_id uuid,
  portal_visible boolean DEFAULT False,
  CONSTRAINT documents_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.email_links (
  id uuid DEFAULT gen_random_uuid(),
  thread_id text NOT NULL,
  account_id uuid,
  service_delivery_id uuid,
  linked_by text DEFAULT manual,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT email_links_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.email_queue (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  lead_id uuid,
  email_template_id uuid,
  to_email text NOT NULL,
  cc_email text[],
  subject text NOT NULL,
  body text NOT NULL,
  status public.email_queue_status DEFAULT Draft,
  created_by text,
  approved_by text,
  approved_at timestamp with time zone,
  sent_at timestamp with time zone,
  error_message text,
  retry_count integer DEFAULT 0,
  gmail_message_id text,
  gmail_thread_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT email_queue_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.email_templates (
  id uuid DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  subject_template text NOT NULL,
  body_template text NOT NULL,
  service_type public.service_type,
  trigger_event text,
  language text DEFAULT English,
  placeholders jsonb,
  category text,
  auto_send boolean DEFAULT False,
  requires_approval boolean DEFAULT True,
  active boolean DEFAULT True,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT email_templates_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.email_tracking (
  id uuid DEFAULT gen_random_uuid(),
  tracking_id text NOT NULL,
  gmail_message_id text,
  gmail_thread_id text,
  recipient text NOT NULL,
  subject text,
  from_email text DEFAULT support@tonydurante.us,
  account_id uuid,
  contact_id uuid,
  lead_id uuid,
  opened boolean DEFAULT False,
  open_count integer DEFAULT 0,
  first_opened_at timestamp with time zone,
  last_opened_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  offer_token text,
  CONSTRAINT email_tracking_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.form_8832_applications (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  account_id uuid,
  contact_id uuid,
  access_code text NOT NULL DEFAULT substr(md5((random())::text), 1, 10),
  company_name text NOT NULL,
  ein text NOT NULL,
  entity_type text NOT NULL DEFAULT Corporation,
  member_count integer NOT NULL DEFAULT 1,
  owner_name text NOT NULL,
  owner_id_number text,
  owner_title text NOT NULL DEFAULT Owner,
  effective_date date,
  status text NOT NULL DEFAULT draft,
  language text NOT NULL DEFAULT en,
  viewed_at timestamp with time zone,
  view_count integer NOT NULL DEFAULT 0,
  signed_at timestamp with time zone,
  pdf_signed_storage_path text,
  pdf_signed_drive_id text,
  is_test boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT form_8832_applications_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.formation_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  lead_id uuid,
  contact_id uuid,
  entity_type text DEFAULT SMLLC,
  state text DEFAULT NM,
  language text DEFAULT en,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  upload_paths text[],
  status text DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT formation_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.generated_documents (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  document_type text NOT NULL,
  fiscal_year integer NOT NULL,
  amount numeric,
  distribution_date date,
  currency text DEFAULT USD,
  status text DEFAULT draft,
  signed_at timestamp with time zone,
  pdf_storage_path text,
  drive_file_id text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  is_test boolean DEFAULT False,
  CONSTRAINT generated_documents_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.hc_tokens (
  id text DEFAULT harbor-compliance,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT hc_tokens_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.hubspot_sync_log (
  id uuid DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  supabase_id uuid NOT NULL,
  hubspot_id text NOT NULL,
  direction public.sync_direction NOT NULL,
  status text DEFAULT Success,
  payload jsonb,
  error_message text,
  synced_at timestamp with time zone DEFAULT now(),
  CONSTRAINT hubspot_sync_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.internal_messages (
  id uuid DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  sender_name text NOT NULL,
  message text NOT NULL,
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  attachment_url text,
  attachment_name text,
  CONSTRAINT internal_messages_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.internal_threads (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  source_message_id uuid,
  created_by uuid NOT NULL,
  title text,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  contact_id uuid,
  CONSTRAINT internal_threads_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.invoice_audit_log (
  id uuid DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  action text NOT NULL,
  changed_fields jsonb,
  previous_values jsonb,
  new_values jsonb,
  performed_by text,
  performed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT invoice_audit_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.invoice_settings (
  id uuid DEFAULT gen_random_uuid(),
  company_name text DEFAULT Tony Durante LLC,
  company_address text DEFAULT 1209 Mountain Road Pl NE, Suite R, Albuquerque, NM 87110,
  company_email text DEFAULT support@tonydurante.us,
  company_phone text,
  tax_id text DEFAULT 99-0662006,
  logo_url text,
  invoice_prefix text DEFAULT TD,
  invoice_footer text,
  default_payment_terms text DEFAULT Payment due upon receipt. Wire transfer to the bank details listed above.,
  bank_accounts jsonb,
  payment_gateways jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT invoice_settings_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.irs_exchange_rates (
  id uuid DEFAULT gen_random_uuid(),
  tax_year integer NOT NULL,
  currency text NOT NULL,
  rate_to_usd numeric NOT NULL,
  source_url text,
  fetched_at timestamp with time zone DEFAULT now(),
  CONSTRAINT irs_exchange_rates_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.itin_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  lead_id uuid,
  account_id uuid,
  contact_id uuid,
  language text NOT NULL DEFAULT en,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  upload_paths text[],
  status text NOT NULL DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT itin_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.job_queue (
  id uuid DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT pending,
  priority integer NOT NULL DEFAULT 5,
  result jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_by text DEFAULT claude,
  account_id uuid,
  lead_id uuid,
  related_entity_type text,
  related_entity_id uuid,
  CONSTRAINT job_queue_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.knowledge_articles (
  id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  category text,
  tags text[],
  version text,
  notes text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT knowledge_articles_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  first_name text,
  last_name text,
  email text,
  phone text,
  source text,
  referrer_name text,
  referrer_partner_id uuid,
  reason text,
  channel public.conversation_channel,
  call_date date,
  status public.lead_status DEFAULT New,
  language text DEFAULT English,
  notes text,
  offer_date date,
  offer_year1_amount numeric,
  offer_year1_currency public.currency DEFAULT EUR,
  offer_annual_amount numeric,
  offer_annual_currency public.currency DEFAULT USD,
  offer_installment_jan numeric,
  offer_installment_jun numeric,
  offer_services text[],
  offer_optional_services text[],
  offer_status public.offer_status,
  offer_notes text,
  gdrive_folder_url text,
  converted_to_contact_id uuid,
  converted_to_account_id uuid,
  converted_at timestamp with time zone,
  airtable_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  offer_link text,
  is_test boolean DEFAULT False,
  circleback_call_id text,
  call_notes text,
  CONSTRAINT leads_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.lease_agreements (
  id uuid DEFAULT gen_random_uuid(),
  token character varying NOT NULL,
  access_code character varying NOT NULL DEFAULT substr(md5((random())::text), 1, 8),
  account_id uuid,
  contact_id uuid,
  landlord_name character varying NOT NULL DEFAULT Tony Durante LLC,
  landlord_address character varying NOT NULL DEFAULT 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771,
  landlord_signer character varying NOT NULL DEFAULT Antonio Durante,
  landlord_title character varying NOT NULL DEFAULT Managing Member,
  tenant_company character varying NOT NULL,
  tenant_ein character varying,
  tenant_state character varying,
  tenant_contact_name character varying NOT NULL,
  tenant_email character varying,
  premises_address character varying NOT NULL DEFAULT 10225 Ulmerton Rd, Largo, FL 33771,
  suite_number character varying NOT NULL,
  square_feet integer NOT NULL DEFAULT 120,
  effective_date date NOT NULL,
  term_start_date date NOT NULL,
  term_end_date date NOT NULL,
  term_months integer NOT NULL DEFAULT 12,
  contract_year integer NOT NULL,
  monthly_rent numeric NOT NULL DEFAULT 100.0,
  yearly_rent numeric NOT NULL DEFAULT 1200.0,
  security_deposit numeric NOT NULL DEFAULT 150.0,
  late_fee numeric NOT NULL DEFAULT 25.0,
  late_fee_per_day numeric NOT NULL DEFAULT 5.0,
  status character varying NOT NULL DEFAULT draft,
  language character varying NOT NULL DEFAULT en,
  view_count integer NOT NULL DEFAULT 0,
  viewed_at timestamp with time zone,
  signed_at timestamp with time zone,
  signed_ip character varying,
  pdf_storage_path character varying,
  pdf_drive_file_id character varying,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  signature_data text,
  CONSTRAINT lease_agreements_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.mcp_tool_counter (
  id integer DEFAULT 1,
  calls_since_checkpoint integer NOT NULL DEFAULT 0,
  last_checkpoint_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mcp_tool_counter_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.message_actions (
  id uuid DEFAULT gen_random_uuid(),
  message_id uuid,
  contact_id uuid,
  account_id uuid,
  action_type text NOT NULL,
  label text,
  created_by text,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT message_actions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.message_responses (
  id uuid DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL,
  draft_text text,
  final_text text,
  status text NOT NULL DEFAULT draft,
  approved_by text,
  sent_via text,
  sent_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT message_responses_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  external_message_id text,
  direction text NOT NULL,
  sender_name text,
  sender_phone text,
  content_type text NOT NULL DEFAULT text,
  content_text text,
  media_url text,
  status text NOT NULL DEFAULT new,
  ai_draft text,
  responded_by text,
  responded_at timestamp with time zone,
  account_id uuid,
  contact_id uuid,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.messaging_channels (
  id uuid DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  channel_name text NOT NULL,
  phone_number text,
  provider text NOT NULL,
  webhook_secret text,
  is_active boolean NOT NULL DEFAULT True,
  config_json jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT messaging_channels_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.messaging_groups (
  id uuid DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL,
  external_group_id text NOT NULL,
  group_name text,
  account_id uuid,
  contact_id uuid,
  lead_id uuid,
  group_type text NOT NULL DEFAULT support_group,
  is_active boolean NOT NULL DEFAULT True,
  last_message_at timestamp with time zone,
  unread_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT messaging_groups_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.oa_agreements (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  access_code text,
  account_id uuid,
  contact_id uuid,
  company_name text NOT NULL,
  state_of_formation text NOT NULL,
  formation_date text,
  ein_number text,
  member_name text NOT NULL,
  member_address text,
  member_email text,
  member_ownership_pct numeric DEFAULT 100,
  effective_date text NOT NULL,
  business_purpose text DEFAULT any and all lawful business activities,
  initial_contribution text DEFAULT $0.00,
  fiscal_year_end text DEFAULT December 31,
  accounting_method text DEFAULT Cash,
  duration text DEFAULT Perpetual,
  registered_agent_name text,
  registered_agent_address text,
  principal_address text DEFAULT 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771,
  status text DEFAULT draft,
  language text DEFAULT en,
  view_count integer DEFAULT 0,
  viewed_at timestamp with time zone,
  signed_at timestamp with time zone,
  signature_data jsonb,
  pdf_storage_path text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  entity_type text DEFAULT SMLLC,
  members jsonb,
  manager_name text,
  total_signers integer DEFAULT 1,
  signed_count integer DEFAULT 0,
  CONSTRAINT oa_agreements_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.oa_signatures (
  id uuid DEFAULT gen_random_uuid(),
  oa_id uuid NOT NULL,
  member_index integer NOT NULL,
  member_name text NOT NULL,
  member_email text,
  contact_id uuid,
  access_code text DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 8),
  status text DEFAULT pending,
  sent_at timestamp with time zone,
  viewed_at timestamp with time zone,
  signed_at timestamp with time zone,
  signature_image_path text,
  signed_by_name text,
  view_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT oa_signatures_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.oauth_clients (
  id uuid DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  client_secret text NOT NULL,
  client_name text,
  redirect_uris text[] NOT NULL,
  grant_types text[] NOT NULL,
  response_types text[] NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT client_secret_post,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.oauth_codes (
  id uuid DEFAULT gen_random_uuid(),
  code text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  user_id text NOT NULL,
  scope text DEFAULT ,
  code_challenge text,
  code_challenge_method text DEFAULT S256,
  expires_at timestamp with time zone NOT NULL,
  used boolean NOT NULL DEFAULT False,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT oauth_codes_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.oauth_tokens (
  id uuid DEFAULT gen_random_uuid(),
  access_token text NOT NULL,
  refresh_token text,
  client_id text NOT NULL,
  user_id text NOT NULL,
  scope text DEFAULT ,
  access_token_expires_at timestamp with time zone NOT NULL,
  refresh_token_expires_at timestamp with time zone,
  revoked boolean NOT NULL DEFAULT False,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.oauth_users (
  id uuid DEFAULT gen_random_uuid(),
  email text NOT NULL,
  pin_hash text NOT NULL,
  name text,
  role text NOT NULL DEFAULT operator,
  active boolean NOT NULL DEFAULT True,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT oauth_users_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.offers (
  id uuid DEFAULT gen_random_uuid(),
  token character varying NOT NULL,
  client_name text NOT NULL,
  client_email text,
  offer_date date NOT NULL DEFAULT CURRENT_DATE,
  intro_en text,
  intro_it text,
  issues jsonb,
  immediate_actions jsonb,
  strategy jsonb,
  services jsonb,
  additional_services jsonb,
  cost_summary jsonb,
  recurring_costs jsonb,
  future_developments jsonb,
  next_steps jsonb,
  status character varying DEFAULT draft,
  expires_at timestamp with time zone,
  viewed_at timestamp with time zone,
  view_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  payment_links jsonb,
  payment_type text DEFAULT none,
  bank_details jsonb,
  effective_date date,
  language character varying NOT NULL DEFAULT it,
  lead_id uuid,
  deal_id uuid,
  referrer_name text,
  referrer_email text,
  referrer_type text,
  referrer_account_id uuid,
  referrer_commission_type text,
  referrer_commission_pct numeric,
  referrer_agreed_price numeric,
  referrer_notes text,
  access_code uuid DEFAULT gen_random_uuid(),
  contract_type text DEFAULT msa,
  account_id uuid,
  bundled_pipelines text[],
  selected_services jsonb,
  required_documents jsonb,
  admin_notes text,
  currency text,
  version integer DEFAULT 1,
  superseded_by text,
  installment_currency text,
  CONSTRAINT offers_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.onboarding_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  lead_id uuid,
  contact_id uuid,
  account_id uuid,
  entity_type text NOT NULL DEFAULT SMLLC,
  state text NOT NULL DEFAULT NM,
  language text NOT NULL DEFAULT en,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  upload_paths text[],
  status text NOT NULL DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT onboarding_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.partner_client_deals (
  partner_client_id uuid,
  deal_id uuid,
  CONSTRAINT partner_client_deals_pkey PRIMARY KEY (partner_client_id, deal_id)
);

CREATE TABLE IF NOT EXISTS public.partner_client_services (
  partner_client_id uuid,
  service_id uuid,
  CONSTRAINT partner_client_services_pkey PRIMARY KEY (partner_client_id, service_id)
);

CREATE TABLE IF NOT EXISTS public.partner_clients (
  id uuid DEFAULT gen_random_uuid(),
  partner_id uuid,
  full_name text NOT NULL,
  company_name text,
  ein text,
  email text,
  phone text,
  passport_on_file boolean DEFAULT False,
  documents_notes text,
  gdrive_folder_url text,
  notes text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT partner_clients_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.partners (
  id uuid DEFAULT gen_random_uuid(),
  partner_name text NOT NULL,
  company text,
  partner_type public.partner_type DEFAULT Referral,
  email text,
  secondary_email text,
  phone text,
  country text,
  service_area text,
  commission_structure text,
  status text DEFAULT Active,
  notes text,
  airtable_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT partners_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.payment_items (
  id uuid DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL,
  amount numeric NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT payment_items_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.payment_links (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  label text NOT NULL,
  url text NOT NULL,
  gateway text NOT NULL,
  amount numeric,
  currency text DEFAULT USD,
  is_default boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT payment_links_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  deal_id uuid,
  description text,
  amount numeric NOT NULL,
  amount_currency public.currency DEFAULT USD,
  period public.payment_period,
  year integer,
  due_date date,
  paid_date date,
  status public.payment_status DEFAULT Pending,
  payment_method text,
  invoice_number text,
  reminder_1_sent date,
  reminder_2_sent date,
  warning_sent date,
  restricted_date date,
  late_fee_amount numeric DEFAULT 0,
  penalty_disclaimer_signed boolean DEFAULT False,
  notes text,
  airtable_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  amount_due numeric,
  evidence_type text,
  payment_record text,
  installment text,
  amount_paid numeric,
  invoice_date date,
  followup_stage text,
  delay_approved_until date,
  qb_invoice_id text,
  contact_id uuid,
  whop_payment_id text,
  invoice_status text,
  issue_date date,
  subtotal numeric,
  discount numeric DEFAULT 0,
  total numeric,
  message text,
  sent_at timestamp with time zone,
  sent_to text,
  reminder_count integer DEFAULT 0,
  last_reminder_at timestamp with time zone,
  qb_sync_status text DEFAULT pending,
  qb_sync_error text,
  billing_entity_id uuid,
  credit_for_payment_id uuid,
  referral_partner_id uuid,
  is_test boolean DEFAULT False,
  portal_invoice_id uuid,
  stripe_payment_id text,
  bank_preference text,
  paid_by_name text,
  CONSTRAINT payments_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.pending_activations (
  id uuid DEFAULT gen_random_uuid(),
  offer_token text NOT NULL,
  lead_id uuid,
  client_name text NOT NULL,
  client_email text NOT NULL,
  amount numeric,
  currency text DEFAULT USD,
  payment_method text,
  status text DEFAULT awaiting_payment,
  signed_at timestamp with time zone,
  payment_confirmed_at timestamp with time zone,
  activated_at timestamp with time zone,
  whop_membership_id text,
  qb_invoice_id text,
  qb_transaction_ref text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  prepared_steps jsonb,
  confirmation_mode text DEFAULT supervised,
  version integer NOT NULL DEFAULT 1,
  portal_invoice_id uuid,
  resolved_context jsonb,
  CONSTRAINT pending_activations_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.pipeline_stages (
  id uuid DEFAULT gen_random_uuid(),
  service_type text NOT NULL,
  stage_order integer NOT NULL,
  stage_name text NOT NULL,
  stage_description text,
  auto_tasks jsonb,
  auto_actions jsonb,
  sla_days integer,
  requires_approval boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  auto_advance boolean DEFAULT True,
  client_description text,
  CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.plaid_connections (
  id uuid DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  access_token text NOT NULL,
  institution_id text,
  institution_name text,
  bank_name text NOT NULL,
  accounts jsonb,
  status text DEFAULT active,
  last_synced_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  sync_cursor text,
  CONSTRAINT plaid_connections_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.portal_audit_log (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid,
  action text NOT NULL,
  detail text,
  ip_address text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT portal_audit_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.portal_issues (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  user_email text,
  area text NOT NULL DEFAULT upload,
  error_message text,
  error_context jsonb,
  status text NOT NULL DEFAULT open,
  resolved_at timestamp with time zone,
  resolved_by text,
  client_notified boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT portal_issues_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.portal_messages (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  sender_type text NOT NULL,
  sender_id uuid NOT NULL,
  message text NOT NULL,
  attachment_url text,
  attachment_name text,
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  contact_id uuid,
  reply_to_id uuid,
  CONSTRAINT portal_messages_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.portal_notifications (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  email_sent_at timestamp with time zone,
  CONSTRAINT portal_notifications_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  contact_id uuid,
  CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.qb_tokens (
  id uuid DEFAULT gen_random_uuid(),
  realm_id text NOT NULL DEFAULT 13845050572680403,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  token_type text NOT NULL DEFAULT bearer,
  access_token_expires_at timestamp with time zone NOT NULL,
  refresh_token_expires_at timestamp with time zone NOT NULL,
  scope text DEFAULT com.intuit.quickbooks.accounting,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  created_by uuid,
  is_active boolean DEFAULT True,
  CONSTRAINT qb_tokens_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.referral_payouts (
  id uuid DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  payout_type text NOT NULL,
  amount numeric NOT NULL,
  currency text DEFAULT EUR,
  invoice_id uuid,
  payment_id uuid,
  reference text,
  notes text,
  is_test boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT referral_payouts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid DEFAULT gen_random_uuid(),
  referrer_contact_id uuid,
  referrer_account_id uuid,
  referred_contact_id uuid,
  referred_account_id uuid,
  referred_lead_id uuid,
  referred_name text NOT NULL,
  offer_token text,
  status text NOT NULL DEFAULT pending,
  commission_type text,
  commission_pct numeric,
  commission_amount numeric,
  commission_currency text DEFAULT EUR,
  credited_amount numeric DEFAULT 0,
  paid_amount numeric DEFAULT 0,
  notes text,
  is_test boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  referrer_type text,
  CONSTRAINT referrals_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.service_catalog (
  id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL,
  default_price numeric,
  default_currency text DEFAULT USD,
  active boolean DEFAULT True,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  slug text,
  category text NOT NULL DEFAULT addon,
  pipeline text,
  contract_type text,
  has_annual boolean NOT NULL DEFAULT False,
  description text,
  CONSTRAINT service_catalog_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.service_deliveries (
  id uuid DEFAULT gen_random_uuid(),
  service_name text NOT NULL,
  service_type text NOT NULL,
  pipeline text,
  stage text,
  account_id uuid,
  contact_id uuid,
  deal_id uuid,
  status text DEFAULT active,
  start_date date,
  end_date date,
  due_date date,
  assigned_to text,
  billing_type text,
  amount numeric,
  amount_currency text DEFAULT USD,
  current_step integer DEFAULT 0,
  total_steps integer DEFAULT 0,
  gdrive_folder_url text,
  hubspot_id text,
  airtable_id text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  stage_order integer,
  stage_entered_at timestamp with time zone,
  stage_history jsonb,
  is_test boolean DEFAULT False,
  CONSTRAINT service_deliveries_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.services (
  id uuid DEFAULT gen_random_uuid(),
  service_name text NOT NULL,
  service_type public.service_type NOT NULL,
  account_id uuid,
  deal_id uuid,
  status public.service_status DEFAULT Not Started,
  start_date date,
  end_date date,
  billing_type public.billing_type DEFAULT Included,
  amount numeric,
  amount_currency public.currency DEFAULT USD,
  current_step integer DEFAULT 1,
  total_steps integer,
  notes text,
  airtable_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  blocked_waiting_external boolean DEFAULT False,
  blocked_reason text,
  blocked_since timestamp with time zone,
  sla_due_date date,
  stage_entered_at timestamp with time zone,
  qc_verified boolean DEFAULT False,
  contact_id uuid,
  CONSTRAINT services_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.session_checkpoints (
  id uuid DEFAULT gen_random_uuid(),
  summary text NOT NULL,
  next_steps text,
  session_type text NOT NULL DEFAULT ops,
  tool_calls_at_save integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_checkpoints_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.signature_requests (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  token text NOT NULL,
  access_code text NOT NULL DEFAULT (gen_random_uuid()),
  document_name text NOT NULL,
  description text,
  pdf_storage_path text NOT NULL,
  signature_coords jsonb,
  status text NOT NULL DEFAULT draft,
  signed_at timestamp with time zone,
  signature_data jsonb,
  signed_pdf_path text,
  signed_pdf_drive_id text,
  created_by text DEFAULT system,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  drive_file_id text,
  CONSTRAINT signature_requests_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.sop_runbooks (
  id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL,
  service_type public.service_type,
  content text NOT NULL,
  version text,
  notes text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT sop_runbooks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.ss4_applications (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  access_code text,
  account_id uuid,
  contact_id uuid,
  company_name text NOT NULL,
  trade_name text,
  entity_type text NOT NULL DEFAULT SMLLC,
  state_of_formation text NOT NULL,
  formation_date text,
  member_count integer NOT NULL DEFAULT 1,
  responsible_party_name text NOT NULL,
  responsible_party_itin text,
  responsible_party_phone text,
  responsible_party_title text NOT NULL DEFAULT Owner,
  county_and_state text,
  status text NOT NULL DEFAULT draft,
  language text DEFAULT en,
  view_count integer DEFAULT 0,
  viewed_at timestamp with time zone,
  signed_at timestamp with time zone,
  signed_ip text,
  signature_data jsonb,
  pdf_unsigned_drive_id text,
  pdf_signed_drive_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ss4_applications_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.system_docs (
  id uuid DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  doc_type text DEFAULT markdown,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT system_docs_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid DEFAULT gen_random_uuid(),
  task_title text NOT NULL,
  assigned_to text NOT NULL,
  status public.task_status DEFAULT To Do,
  priority public.task_priority DEFAULT Normal,
  due_date date,
  category public.task_category,
  description text,
  created_by text,
  completed_date date,
  notified boolean DEFAULT False,
  account_id uuid,
  deal_id uuid,
  service_id uuid,
  notes text,
  airtable_id text,
  zoho_task_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  stage_order integer,
  delivery_id uuid,
  contact_id uuid,
  attachments jsonb NOT NULL,
  CONSTRAINT tasks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.tax_quote_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  lead_id uuid,
  offer_token text,
  llc_name text,
  llc_state text,
  llc_type text,
  tax_year integer,
  client_name text,
  client_email text,
  client_phone text,
  language text DEFAULT en,
  status text DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  processed_at timestamp with time zone,
  client_ip text,
  client_user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tax_quote_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.tax_return_submissions (
  id uuid DEFAULT gen_random_uuid(),
  token text NOT NULL,
  account_id uuid,
  contact_id uuid,
  tax_year integer NOT NULL DEFAULT 2025,
  entity_type text NOT NULL DEFAULT SMLLC,
  prefilled_data jsonb,
  submitted_data jsonb,
  changed_fields jsonb,
  has_articles_on_file boolean DEFAULT False,
  has_ein_letter_on_file boolean DEFAULT False,
  status text DEFAULT pending,
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  completed_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  client_ip text,
  client_user_agent text,
  confirmation_accepted boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  language text DEFAULT en,
  tax_return_id uuid,
  upload_paths jsonb,
  access_code text DEFAULT encode(extensions.gen_random_bytes(4), 'hex'::text),
  CONSTRAINT tax_return_submissions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.tax_returns (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  company_name text NOT NULL,
  client_name text,
  return_type public.tax_return_type NOT NULL,
  tax_year integer NOT NULL,
  deadline date NOT NULL,
  status public.tax_return_status DEFAULT Payment Pending,
  paid boolean DEFAULT False,
  deal_created boolean DEFAULT False,
  link_sent boolean DEFAULT False,
  link_sent_date date,
  data_received boolean DEFAULT False,
  data_received_date date,
  sent_to_india boolean DEFAULT False,
  sent_to_india_date date,
  extension_filed boolean DEFAULT False,
  extension_deadline date,
  india_status public.india_status DEFAULT Not Sent,
  special_case boolean DEFAULT False,
  notes text,
  airtable_id text,
  hubspot_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  extension_requested_date date,
  extension_confirmed_date date,
  first_year_skip boolean DEFAULT False,
  india_follow_up_count integer DEFAULT 0,
  contact_id uuid,
  extension_submission_id text,
  CONSTRAINT tax_returns_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.td_bank_feeds (
  id uuid DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text,
  transaction_date date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT USD,
  sender_name text,
  sender_reference text,
  memo text,
  raw_data jsonb,
  matched_payment_id uuid,
  match_confidence text,
  matched_at timestamp with time zone,
  matched_by text,
  status text NOT NULL DEFAULT unmatched,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT td_bank_feeds_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.td_expense_items (
  id uuid DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric DEFAULT 1,
  unit_price numeric DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  sort_order integer DEFAULT 0,
  CONSTRAINT td_expense_items_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.td_expenses (
  id uuid DEFAULT gen_random_uuid(),
  vendor_name text NOT NULL,
  invoice_number text,
  description text,
  currency text NOT NULL DEFAULT USD,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  issue_date date,
  due_date date,
  paid_date date,
  status text NOT NULL DEFAULT Pending,
  payment_method text,
  category text DEFAULT Operations,
  account_id uuid,
  qb_bill_id text,
  attachment_url text,
  attachment_name text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT td_expenses_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.templates (
  id uuid DEFAULT gen_random_uuid(),
  template_number integer,
  template_name text NOT NULL,
  trigger_keyword text,
  category text,
  language text DEFAULT English,
  template_text text NOT NULL,
  placeholders text[],
  auto_apply boolean DEFAULT False,
  service_type public.service_type,
  notes text,
  airtable_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT templates_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.webhook_debug (
  id integer,
  payload jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT webhook_debug_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid DEFAULT gen_random_uuid(),
  source text NOT NULL,
  event_type text NOT NULL,
  external_id text,
  payload jsonb,
  created_at timestamp with time zone DEFAULT now(),
  review_status text DEFAULT pending_review,
  CONSTRAINT webhook_events_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.whop_events (
  id uuid DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_id text,
  whop_payment_id text,
  whop_membership_id text,
  whop_user_id text,
  whop_plan_id text,
  whop_product_id text,
  amount_cents integer,
  currency text DEFAULT usd,
  status text,
  customer_email text,
  customer_name text,
  metadata jsonb,
  processed boolean DEFAULT False,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT whop_events_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.wizard_progress (
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid,
  contact_id uuid,
  wizard_type text NOT NULL,
  current_step integer DEFAULT 1,
  data jsonb,
  status text DEFAULT in_progress,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT wizard_progress_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.work_locks (
  id uuid DEFAULT gen_random_uuid(),
  locked_by text NOT NULL,
  file_path text NOT NULL,
  reason text NOT NULL,
  claimed_at timestamp with time zone NOT NULL DEFAULT now(),
  released_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT work_locks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.write_buffer (
  id uuid DEFAULT gen_random_uuid(),
  target_table text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  status text DEFAULT Pending,
  target_record_id uuid,
  error_message text,
  retry_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  synced_at timestamp with time zone,
  CONSTRAINT write_buffer_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.zoho_templates (
  id uuid DEFAULT gen_random_uuid(),
  zoho_id text NOT NULL,
  name text NOT NULL,
  subject text,
  module text,
  content text,
  has_attachments boolean DEFAULT False,
  attachment_names text[],
  status text DEFAULT imported,
  migrated_to text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT zoho_templates_pkey PRIMARY KEY (id)
);

-- Foreign Key Constraints
-- (wrapped in DO block to skip if already exist or target missing)
DO $$
BEGIN
  BEGIN
    ALTER TABLE IF EXISTS public.account_contacts ADD CONSTRAINT account_contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.account_contacts ADD CONSTRAINT account_contacts_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.accounts ADD CONSTRAINT accounts_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.client_partners(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.action_log ADD CONSTRAINT action_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.action_log ADD CONSTRAINT action_log_session_checkpoint_id_fkey FOREIGN KEY (session_checkpoint_id) REFERENCES public.session_checkpoints(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.action_log ADD CONSTRAINT action_log_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.agent_decisions ADD CONSTRAINT agent_decisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.agent_decisions ADD CONSTRAINT agent_decisions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.agent_decisions ADD CONSTRAINT agent_decisions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.ai_embeddings ADD CONSTRAINT ai_embeddings_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.ai_facts ADD CONSTRAINT ai_facts_source_session_id_fkey FOREIGN KEY (source_session_id) REFERENCES public.ai_sessions(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.ai_facts ADD CONSTRAINT ai_facts_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.ai_facts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.ai_messages ADD CONSTRAINT ai_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.bank_transactions ADD CONSTRAINT bank_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.banking_submissions ADD CONSTRAINT banking_submissions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.banking_submissions ADD CONSTRAINT banking_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.billing_entities ADD CONSTRAINT billing_entities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.billing_entities ADD CONSTRAINT billing_entities_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.call_summaries ADD CONSTRAINT call_summaries_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.call_summaries ADD CONSTRAINT call_summaries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.call_summaries ADD CONSTRAINT call_summaries_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_bank_accounts ADD CONSTRAINT client_bank_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_correspondence ADD CONSTRAINT client_correspondence_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_correspondence ADD CONSTRAINT client_correspondence_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_credit_notes ADD CONSTRAINT client_credit_notes_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_credit_notes ADD CONSTRAINT client_credit_notes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_credit_notes ADD CONSTRAINT client_credit_notes_original_invoice_id_fkey FOREIGN KEY (original_invoice_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_credit_notes ADD CONSTRAINT client_credit_notes_applied_to_invoice_id_fkey FOREIGN KEY (applied_to_invoice_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_customers ADD CONSTRAINT client_customers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_customers ADD CONSTRAINT client_customers_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_expense_items ADD CONSTRAINT client_expense_items_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.client_expenses(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_expenses ADD CONSTRAINT client_expenses_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_expenses ADD CONSTRAINT client_expenses_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.client_vendors(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_expenses ADD CONSTRAINT client_expenses_td_payment_id_fkey FOREIGN KEY (td_payment_id) REFERENCES public.payments(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_expenses ADD CONSTRAINT client_expenses_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_interactions ADD CONSTRAINT client_interactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_interactions ADD CONSTRAINT client_interactions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_interactions ADD CONSTRAINT client_interactions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoice_documents ADD CONSTRAINT client_invoice_documents_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoice_documents ADD CONSTRAINT client_invoice_documents_sales_invoice_id_fkey FOREIGN KEY (sales_invoice_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoice_documents ADD CONSTRAINT client_invoice_documents_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.client_expenses(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoice_items ADD CONSTRAINT client_invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoice_templates ADD CONSTRAINT client_invoice_templates_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoice_templates ADD CONSTRAINT client_invoice_templates_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.client_customers(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoices ADD CONSTRAINT client_invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoices ADD CONSTRAINT client_invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.client_customers(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoices ADD CONSTRAINT client_invoices_recurring_parent_id_fkey FOREIGN KEY (recurring_parent_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoices ADD CONSTRAINT client_invoices_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.client_bank_accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoices ADD CONSTRAINT client_invoices_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_invoices ADD CONSTRAINT client_invoices_parent_invoice_id_fkey FOREIGN KEY (parent_invoice_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_partners ADD CONSTRAINT client_partners_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.client_vendors ADD CONSTRAINT client_vendors_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.closure_submissions ADD CONSTRAINT closure_submissions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.closure_submissions ADD CONSTRAINT closure_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.closure_submissions ADD CONSTRAINT closure_submissions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.compliance_requirements ADD CONSTRAINT compliance_requirements_document_type_name_fkey FOREIGN KEY (document_type_name) REFERENCES public.document_types(type_name);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.contacts ADD CONSTRAINT contacts_primary_company_id_fkey FOREIGN KEY (primary_company_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.contracts ADD CONSTRAINT contracts_offer_token_fkey FOREIGN KEY (offer_token) REFERENCES public.offers(token);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.conversations ADD CONSTRAINT conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.conversations ADD CONSTRAINT conversations_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.deadlines ADD CONSTRAINT deadlines_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.deals ADD CONSTRAINT deals_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.deals ADD CONSTRAINT deals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.deals ADD CONSTRAINT deals_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.dev_tasks ADD CONSTRAINT dev_tasks_parent_task_id_fkey FOREIGN KEY (parent_task_id) REFERENCES public.dev_tasks(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.documents ADD CONSTRAINT documents_document_type_id_fkey FOREIGN KEY (document_type_id) REFERENCES public.document_types(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.documents ADD CONSTRAINT documents_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.documents ADD CONSTRAINT documents_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_links ADD CONSTRAINT email_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_links ADD CONSTRAINT email_links_service_delivery_id_fkey FOREIGN KEY (service_delivery_id) REFERENCES public.service_deliveries(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_queue ADD CONSTRAINT email_queue_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_queue ADD CONSTRAINT email_queue_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_queue ADD CONSTRAINT email_queue_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_queue ADD CONSTRAINT email_queue_email_template_id_fkey FOREIGN KEY (email_template_id) REFERENCES public.email_templates(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_tracking ADD CONSTRAINT email_tracking_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_tracking ADD CONSTRAINT email_tracking_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.email_tracking ADD CONSTRAINT email_tracking_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.form_8832_applications ADD CONSTRAINT form_8832_applications_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.form_8832_applications ADD CONSTRAINT form_8832_applications_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.formation_submissions ADD CONSTRAINT formation_submissions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.formation_submissions ADD CONSTRAINT formation_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.generated_documents ADD CONSTRAINT generated_documents_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.generated_documents ADD CONSTRAINT generated_documents_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.internal_messages ADD CONSTRAINT internal_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.internal_threads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.internal_threads ADD CONSTRAINT internal_threads_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.internal_threads ADD CONSTRAINT internal_threads_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.itin_submissions ADD CONSTRAINT itin_submissions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.itin_submissions ADD CONSTRAINT itin_submissions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.itin_submissions ADD CONSTRAINT itin_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.job_queue ADD CONSTRAINT job_queue_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.job_queue ADD CONSTRAINT job_queue_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.leads ADD CONSTRAINT leads_converted_to_contact_id_fkey FOREIGN KEY (converted_to_contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.leads ADD CONSTRAINT leads_converted_to_account_id_fkey FOREIGN KEY (converted_to_account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.lease_agreements ADD CONSTRAINT lease_agreements_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.lease_agreements ADD CONSTRAINT lease_agreements_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.message_actions ADD CONSTRAINT message_actions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.portal_messages(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.message_actions ADD CONSTRAINT message_actions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.message_actions ADD CONSTRAINT message_actions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.message_responses ADD CONSTRAINT message_responses_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messages ADD CONSTRAINT messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.messaging_groups(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messages ADD CONSTRAINT messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.messaging_channels(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messages ADD CONSTRAINT messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messages ADD CONSTRAINT messages_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messaging_groups ADD CONSTRAINT messaging_groups_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.messaging_channels(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messaging_groups ADD CONSTRAINT messaging_groups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messaging_groups ADD CONSTRAINT messaging_groups_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.messaging_groups ADD CONSTRAINT messaging_groups_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.oa_agreements ADD CONSTRAINT oa_agreements_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.oa_agreements ADD CONSTRAINT oa_agreements_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.oa_signatures ADD CONSTRAINT oa_signatures_oa_id_fkey FOREIGN KEY (oa_id) REFERENCES public.oa_agreements(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.oa_signatures ADD CONSTRAINT oa_signatures_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.oauth_codes ADD CONSTRAINT oauth_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.oauth_tokens ADD CONSTRAINT oauth_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.offers ADD CONSTRAINT offers_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.offers ADD CONSTRAINT offers_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.offers ADD CONSTRAINT offers_referrer_account_id_fkey FOREIGN KEY (referrer_account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.offers ADD CONSTRAINT offers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.onboarding_submissions ADD CONSTRAINT onboarding_submissions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.onboarding_submissions ADD CONSTRAINT onboarding_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.onboarding_submissions ADD CONSTRAINT onboarding_submissions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.partner_client_deals ADD CONSTRAINT partner_client_deals_partner_client_id_fkey FOREIGN KEY (partner_client_id) REFERENCES public.partner_clients(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.partner_client_deals ADD CONSTRAINT partner_client_deals_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.partner_client_services ADD CONSTRAINT partner_client_services_partner_client_id_fkey FOREIGN KEY (partner_client_id) REFERENCES public.partner_clients(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.partner_client_services ADD CONSTRAINT partner_client_services_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.partner_clients ADD CONSTRAINT partner_clients_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payment_items ADD CONSTRAINT payment_items_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payment_links ADD CONSTRAINT payment_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payments ADD CONSTRAINT payments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payments ADD CONSTRAINT payments_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payments ADD CONSTRAINT payments_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payments ADD CONSTRAINT payments_credit_for_payment_id_fkey FOREIGN KEY (credit_for_payment_id) REFERENCES public.payments(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.payments ADD CONSTRAINT payments_referral_partner_id_fkey FOREIGN KEY (referral_partner_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.pending_activations ADD CONSTRAINT pending_activations_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_issues ADD CONSTRAINT portal_issues_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_issues ADD CONSTRAINT portal_issues_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_messages ADD CONSTRAINT portal_messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_messages ADD CONSTRAINT portal_messages_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_messages ADD CONSTRAINT portal_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.portal_messages(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_notifications ADD CONSTRAINT portal_notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.portal_notifications ADD CONSTRAINT portal_notifications_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.push_subscriptions ADD CONSTRAINT push_subscriptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.push_subscriptions ADD CONSTRAINT push_subscriptions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referral_payouts ADD CONSTRAINT referral_payouts_referral_id_fkey FOREIGN KEY (referral_id) REFERENCES public.referrals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referral_payouts ADD CONSTRAINT referral_payouts_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.client_invoices(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referral_payouts ADD CONSTRAINT referral_payouts_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referrals ADD CONSTRAINT referrals_referrer_contact_id_fkey FOREIGN KEY (referrer_contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referrals ADD CONSTRAINT referrals_referrer_account_id_fkey FOREIGN KEY (referrer_account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referrals ADD CONSTRAINT referrals_referred_contact_id_fkey FOREIGN KEY (referred_contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referrals ADD CONSTRAINT referrals_referred_account_id_fkey FOREIGN KEY (referred_account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.referrals ADD CONSTRAINT referrals_referred_lead_id_fkey FOREIGN KEY (referred_lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.service_deliveries ADD CONSTRAINT service_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.service_deliveries ADD CONSTRAINT service_deliveries_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.service_deliveries ADD CONSTRAINT service_deliveries_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.services ADD CONSTRAINT services_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.services ADD CONSTRAINT services_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.services ADD CONSTRAINT services_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.signature_requests ADD CONSTRAINT signature_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.signature_requests ADD CONSTRAINT signature_requests_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.ss4_applications ADD CONSTRAINT ss4_applications_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.ss4_applications ADD CONSTRAINT ss4_applications_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tasks ADD CONSTRAINT tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tasks ADD CONSTRAINT tasks_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tasks ADD CONSTRAINT tasks_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tasks ADD CONSTRAINT tasks_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.service_deliveries(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tasks ADD CONSTRAINT tasks_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tax_quote_submissions ADD CONSTRAINT tax_quote_submissions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tax_return_submissions ADD CONSTRAINT tax_return_submissions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tax_return_submissions ADD CONSTRAINT tax_return_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tax_return_submissions ADD CONSTRAINT tax_return_submissions_tax_return_id_fkey FOREIGN KEY (tax_return_id) REFERENCES public.tax_returns(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tax_returns ADD CONSTRAINT tax_returns_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.tax_returns ADD CONSTRAINT tax_returns_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.td_bank_feeds ADD CONSTRAINT td_bank_feeds_matched_payment_id_fkey FOREIGN KEY (matched_payment_id) REFERENCES public.payments(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.td_expense_items ADD CONSTRAINT td_expense_items_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.td_expenses(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.td_expenses ADD CONSTRAINT td_expenses_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.wizard_progress ADD CONSTRAINT wizard_progress_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE IF EXISTS public.wizard_progress ADD CONSTRAINT wizard_progress_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;