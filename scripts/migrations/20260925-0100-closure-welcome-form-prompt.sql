-- Dev job e2fee7e7 — the closure welcome must tell the client to fill in the
-- closure form (it used to say "we'll reach out with documents"), and a closure
-- line is appended to OTHER welcomes when a closure form is owed (text below,
-- read by lib/portal/welcome-message.ts getClosureWelcomeAddendum).
-- Data-only; idempotent (re-running writes the same values).

UPDATE catalog_entries
SET
  description = 'Hi {{firstName}}, we''re starting the closure of your company. To go ahead we need a few details from you: please fill in the closure form. You will find it on your portal home page, under "Complete Registration — Company Closure". Message us here if anything is unclear.',
  description_translations = COALESCE(description_translations, '{}'::jsonb) || jsonb_build_object(
    'it', 'Caro {{firstName}}, stiamo avviando la chiusura della tua società. Per procedere ci servono alcuni dati: compila il modulo di chiusura. Lo trovi nella home del tuo portale, nel riquadro "Completa Registrazione — Chiusura Società". Scrivici qui se qualcosa non è chiaro.'
  ),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'addendum', jsonb_build_object(
      'en', 'We are also closing your previous company: please fill in the closure form. You will find it on your portal home page, under "Complete Registration — Company Closure".',
      'it', 'Stiamo anche chiudendo la tua società precedente: compila il modulo di chiusura. Lo trovi nella home del tuo portale, nel riquadro "Completa Registrazione — Chiusura Società".'
    )
  ),
  updated_at = now()
WHERE catalog_id = 'welcome_messages' AND slug = 'closure';

SELECT slug, description, description_translations->>'it' AS it, metadata FROM catalog_entries
WHERE catalog_id = 'welcome_messages' AND slug = 'closure';
