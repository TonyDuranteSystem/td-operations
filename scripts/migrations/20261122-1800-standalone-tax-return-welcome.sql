-- Standalone company tax return: the welcome message a client gets in the portal chat when they buy ONLY a tax return and the company is known
-- (Antonio, 22 Nov 2026, dev job 6f555c9f). Their tax form is open from the moment the payment is confirmed, so this welcome says so — the plain
-- tax-return welcome ("we'll reach out when we need documents") is wrong for them.
-- Data-only (one catalog row in welcome_messages, editable from the CRM /catalog page); idempotent (a row that is already there is left alone,
-- so an edit made later in /catalog is never overwritten). The code side (STANDALONE_TAX_RETURN_WELCOME_SLUG in lib/portal/welcome-message.ts) picks it
-- only for a standalone return; if this row is missing the plain tax-return welcome still wins, exactly as before.
-- Priority 75 = just above the plain tax-return welcome (70), so it wins for the standalone return and for nothing else.
-- Wording DRAFT — Antonio approves it before this runs on production.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, display_name_translations, description, description_translations, status, metadata)
SELECT 'welcome_messages', 'tax_return_standalone',
       'Welcome — your tax return is ready to start',
       '{"it": "Benvenuto — la tua dichiarazione è pronta per iniziare"}'::jsonb,
       'Hi {{firstName}}, thank you for your order for {{companyName}}. Your tax form is open in your portal now: fill it in and upload your documents, and we''ll prepare your return from there. Your portal shows everything for this service — your documents, anything to sign and your invoice. Message us here if anything is unclear.',
       jsonb_build_object('it', 'Caro {{firstName}}, grazie per il tuo ordine per {{companyName}}. Il modulo fiscale è già aperto nel tuo portale: compilalo e carica i documenti, e da lì prepariamo la tua dichiarazione. Il portale mostra tutto ciò che riguarda questo servizio: documenti, eventuali firme e la fattura. Scrivici qui se qualcosa non è chiaro.'),
       'active',
       '{"priority": 75, "wizard_path": "/portal"}'::jsonb
 WHERE EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'welcome_messages')
   AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'tax_return_standalone');

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'welcome_messages')
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'tax_return_standalone' AND status = 'active') THEN
    RAISE EXCEPTION 'tax-return-standalone-welcome: the welcome row is missing after the insert';
  END IF;
END
$do$;
COMMIT;

SELECT slug, display_name, metadata FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'tax_return_standalone';
