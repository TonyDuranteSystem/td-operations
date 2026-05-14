-- Welcome Messages catalog — bilingual portal-chat templates sent automatically
-- when a client activates a service. Editable from the CRM /catalog page (no
-- deploy required). Used by lib/operations/activate-service.ts via
-- lib/portal/welcome-message.ts.
--
-- Templates support {{firstName}}, {{lastName}}, {{companyName}}, {{serviceName}},
-- {{wizardUrl}} placeholders. For bundled offers, the activation function picks
-- the template matching the highest-priority service in the bundle
-- (metadata.priority, descending).
--
-- Apply to SANDBOX:
--   node scripts/apply-migration.js scripts/migrations/20260514-1500-welcome-messages-catalog.sql
-- Idempotent: ON CONFLICT DO NOTHING on (id) for definition, (catalog_id, slug) for entries.

-- ─────────────────────────────────────────────────────────────────────────
-- Step 1: catalog_definitions — register the 'welcome_messages' catalog
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO catalog_definitions (id, display_name, display_name_translations, description, admin_can_add_rows, tags_schema)
VALUES (
  'welcome_messages',
  'Welcome Messages',
  '{"it": "Messaggi di Benvenuto"}'::jsonb,
  'Bilingual portal-chat templates sent automatically when a client activates a service. Supports {{firstName}}, {{lastName}}, {{companyName}}, {{serviceName}}, {{wizardUrl}} placeholders. The activation function picks the template matching the highest-priority service in a bundled offer (metadata.priority desc).',
  true,
  '{"valid_tags": ["post_payment", "wizard", "deprecated"]}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Step 2: catalog_entries — one row per service slug that gets a welcome
--
-- display_name           = English title of the chat message
-- display_name_translations.it = Italian title
-- description            = English body
-- description_translations.it  = Italian body
-- metadata.priority      = bundle-resolution priority (higher wins)
-- metadata.wizard_path   = portal path the notification links to (optional)
-- ─────────────────────────────────────────────────────────────────────────

-- client_onboarding — priority 100 (existing LLC bringing books over)
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'client_onboarding',
  'Welcome onboard — let''s get your company set up with us',
  '{"it": "Benvenuto a bordo — sistemiamo subito la tua azienda"}'::jsonb,
  'Hi {{firstName}}, welcome aboard! To get {{companyName}} fully set up with us, open the portal and complete the onboarding wizard. Each question feeds directly into our records — read them carefully. If anything is unclear, just message us right here.',
  '{"it": "Caro {{firstName}}, benvenuto a bordo! Per sistemare {{companyName}} con noi, accedi al portale e completa il wizard di onboarding. Ogni domanda alimenta direttamente i nostri archivi: leggile con attenzione. Se qualcosa non è chiaro, scrivici pure qui."}'::jsonb,
  'active',
  '["post_payment", "wizard"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 100, "wizard_path": "/portal/wizard"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- company_formation — priority 90
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'company_formation',
  'Welcome onboard — let''s start forming your company',
  '{"it": "Benvenuto a bordo — iniziamo a costituire la tua azienda"}'::jsonb,
  'Hi {{firstName}}, welcome aboard! Open the portal and complete the formation wizard so we can start forming {{companyName}}. Read each question carefully — your answers go directly into the formation filing. If anything is unclear, message us here.',
  '{"it": "Caro {{firstName}}, benvenuto a bordo! Accedi al portale e completa il wizard di costituzione per far partire {{companyName}}. Leggi attentamente ogni domanda — le risposte finiscono direttamente nei documenti di costituzione. Se qualcosa non è chiaro, scrivici qui."}'::jsonb,
  'active',
  '["post_payment", "wizard"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 90, "wizard_path": "/portal/wizard"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- itin — priority 80
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'itin',
  'Welcome — your ITIN application is being set up',
  '{"it": "Benvenuto — il tuo servizio ITIN è in lavorazione"}'::jsonb,
  'Hi {{firstName}}, your ITIN wizard is ready. Open the portal and complete the form — read each question carefully because the answers go directly into your ITIN application. If anything is unclear, message us here.',
  '{"it": "Caro {{firstName}}, il wizard per il tuo ITIN è pronto. Trovi il modulo direttamente nel portale. Leggi attentamente ogni domanda prima di rispondere, poiché le informazioni saranno utilizzate per la tua pratica ITIN. Se qualcosa non è chiaro, scrivici pure qui."}'::jsonb,
  'active',
  '["post_payment", "wizard"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 80, "wizard_path": "/portal/wizard"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- tax_return — priority 70
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'tax_return',
  'Welcome — your Tax Return is being set up',
  '{"it": "Benvenuto — la tua dichiarazione fiscale è in lavorazione"}'::jsonb,
  'Hi {{firstName}}, we''re preparing your tax return for {{companyName}}. We''ll reach out when we need documents or signatures. In the meantime, you can upload anything tax-related from the portal. Message us here if anything is unclear.',
  '{"it": "Caro {{firstName}}, stiamo preparando la dichiarazione fiscale per {{companyName}}. Ti contatteremo quando serviranno documenti o firme. Nel frattempo, puoi caricare tutto il materiale fiscale direttamente dal portale. Scrivici pure qui se qualcosa non è chiaro."}'::jsonb,
  'active',
  '["post_payment"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 70, "wizard_path": "/portal"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- banking — priority 60 (Banking Fintech)
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'banking',
  'Welcome — your banking application is being set up',
  '{"it": "Benvenuto — la tua apertura conto è in lavorazione"}'::jsonb,
  'Hi {{firstName}}, your banking wizard is ready. Open the portal and fill it in — the answers feed directly into the bank application for {{companyName}}. If anything is unclear, message us here.',
  '{"it": "Caro {{firstName}}, il wizard per l''apertura del conto è pronto. Accedi al portale e completa il modulo — le risposte alimentano direttamente la richiesta bancaria per {{companyName}}. Se qualcosa non è chiaro, scrivici qui."}'::jsonb,
  'active',
  '["post_payment", "wizard"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 60, "wizard_path": "/portal/wizard"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- banking_physical — priority 55
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'banking_physical',
  'Welcome — your physical bank account is being set up',
  '{"it": "Benvenuto — il tuo conto bancario fisico è in lavorazione"}'::jsonb,
  'Hi {{firstName}}, we''re preparing the physical bank account application for {{companyName}}. We''ll reach out with the next step shortly. Upload any banking documents through the portal and message us here if anything is unclear.',
  '{"it": "Caro {{firstName}}, stiamo preparando la richiesta di conto fisico per {{companyName}}. A breve ti contatteremo per il prossimo passo. Carica eventuali documenti bancari dal portale e scrivici qui se qualcosa non è chiaro."}'::jsonb,
  'active',
  '["post_payment"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 55, "wizard_path": "/portal"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- ein — priority 50
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'ein',
  'Welcome — your EIN application is being set up',
  '{"it": "Benvenuto — la tua richiesta EIN è in lavorazione"}'::jsonb,
  'Hi {{firstName}}, we''re preparing the EIN application for {{companyName}}. We''ll handle the filing on our side — you''ll get a portal notification as soon as the EIN is issued. Message us here if you need anything in the meantime.',
  '{"it": "Caro {{firstName}}, stiamo preparando la richiesta EIN per {{companyName}}. Ce ne occupiamo noi — riceverai una notifica nel portale appena l''EIN sarà emesso. Scrivici qui se ti serve qualcosa nel frattempo."}'::jsonb,
  'active',
  '["post_payment"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 50, "wizard_path": "/portal"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- closure — priority 40
INSERT INTO catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, tags, capabilities, metadata)
VALUES (
  'welcome_messages',
  'closure',
  'Welcome — your company closure is being set up',
  '{"it": "Benvenuto — la chiusura della tua azienda è in lavorazione"}'::jsonb,
  'Hi {{firstName}}, we''re starting the closure process for {{companyName}}. We''ll reach out with the documents that need your signature and any final filings. You can upload supporting documents from the portal — message us here if anything is unclear.',
  '{"it": "Caro {{firstName}}, stiamo avviando il processo di chiusura per {{companyName}}. Ti contatteremo con i documenti da firmare e gli ultimi adempimenti. Puoi caricare i documenti di supporto dal portale — scrivici qui se qualcosa non è chiaro."}'::jsonb,
  'active',
  '["post_payment"]'::jsonb,
  '{}'::jsonb,
  '{"priority": 40, "wizard_path": "/portal"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;
