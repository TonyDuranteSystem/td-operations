-- Bank CSV-export guide library (master plan §3.1/§8 — fuzzy-matched help,
-- NEVER a constraining list). One catalog entry per platform; the wizard
-- matches the client's free-text bank name against metadata.match_terms and
-- shows the steps under that bank's upload field. Staff add/edit banks via
-- the catalog — no deploy.
-- Steps verified against official help centers 2026-06-12 (sources in
-- metadata.source). Slash: CSV export exists (real client files in hand)
-- but is not publicly documented — steps kept generic on purpose.
-- Chase: official row/date caps unpublished; the note tells clients to
-- re-download by quarter if the file looks cut off.

-- Register the catalog itself (catalog_entries.catalog_id is a FK).
INSERT INTO public.catalog_definitions (id, display_name, description, admin_can_add_rows)
SELECT 'bank_export_guides', 'Bank CSV Export Guides', 'Per-bank step-by-step instructions shown in the tax wizard when the client types a matching bank name. metadata: match_terms[], steps_en[], steps_it[], note_en, note_it, source.', true
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'bank_export_guides');

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT v.catalog_id, v.slug, v.display_name, 'active', v.metadata::jsonb
FROM (VALUES
  ('bank_export_guides', 'mercury', 'Mercury', '{
    "match_terms": ["mercury"],
    "steps_en": ["Log in to Mercury on the web and click Transactions in the left sidebar.", "Use the date filter at the top: set January 1 to December 31 of the tax year.", "Click Export and download the CSV."],
    "steps_it": ["Accedi a Mercury dal web e clicca Transactions nella barra laterale.", "Usa il filtro date in alto: imposta dal 1 gennaio al 31 dicembre dell''anno fiscale.", "Clicca Export e scarica il CSV."],
    "note_en": "One file covers the whole year. Web only.",
    "note_it": "Un solo file copre tutto l''anno. Solo dal web.",
    "source": "https://support.mercury.com/hc/en-us/articles/28768700685844"
  }'),
  ('bank_export_guides', 'relay', 'Relay', '{
    "match_terms": ["relay"],
    "steps_en": ["Sign in to Relay on the web, open the Accounts tab and choose Statements.", "Select ALL 12 monthly statements of the tax year.", "Click Export, then Download statements, and choose CSV as the file type.", "Upload all 12 files here — add them together in this same section."],
    "steps_it": ["Accedi a Relay dal web, apri la scheda Accounts e scegli Statements.", "Seleziona TUTTI i 12 estratti mensili dell''anno fiscale.", "Clicca Export, poi Download statements, e scegli CSV come formato.", "Carica qui tutti i 12 file — aggiungili insieme in questa stessa sezione."],
    "note_en": "Relay exports one CSV per month — select all 12 together; you can upload multiple files here.",
    "note_it": "Relay esporta un CSV per ogni mese — selezionali tutti e 12 insieme; qui puoi caricare più file.",
    "source": "https://support.relayfi.com/hc/en-us/articles/360038797251"
  }'),
  ('bank_export_guides', 'wise', 'Wise', '{
    "match_terms": ["wise", "transferwise"],
    "steps_en": ["Log in to Wise on the web, click your profile icon, then Statements and reports, then Statement.", "Choose the currency balance (do one statement per currency you used).", "Set the period: January 1 to December 31 of the tax year.", "Choose CSV as the format and download."],
    "steps_it": ["Accedi a Wise dal web, clicca sull''icona del profilo, poi Statements and reports, poi Statement.", "Scegli il saldo valuta (fai un estratto per ogni valuta usata).", "Imposta il periodo: dal 1 gennaio al 31 dicembre dell''anno fiscale.", "Scegli CSV come formato e scarica."],
    "note_en": "One statement per currency — if you used USD and EUR, download both and upload both here.",
    "note_it": "Un estratto per ogni valuta — se hai usato USD e EUR, scaricali entrambi e caricali entrambi qui.",
    "source": "https://wise.com/help/articles/2736049"
  }'),
  ('bank_export_guides', 'revolut', 'Revolut', '{
    "match_terms": ["revolut"],
    "steps_en": ["Log in to the Revolut Business web portal and open Accounts; select the account.", "Open Account statements and choose Custom as the period: January 1 to December 31.", "Choose CSV as the file type and click Generate, then download."],
    "steps_it": ["Accedi al portale web Revolut Business e apri Accounts; seleziona il conto.", "Apri Account statements e scegli Custom come periodo: dal 1 gennaio al 31 dicembre.", "Scegli CSV come formato, clicca Generate e scarica."],
    "note_en": "One export covers the whole year. Repeat per currency account if you have more than one.",
    "note_it": "Un export copre tutto l''anno. Ripeti per ogni conto valuta se ne hai più di uno.",
    "source": "https://help.revolut.com/business/help/managing-my-business/viewing-my-account-statements"
  }'),
  ('bank_export_guides', 'slash', 'Slash', '{
    "match_terms": ["slash"],
    "steps_en": ["Log in to Slash on the web and open your account''s Transactions view.", "Look for the Export / Download option and set the dates to the entire tax year.", "Download the CSV. If you only find PDF statements, contact Slash support and ask for the CSV transaction export — it exists."],
    "steps_it": ["Accedi a Slash dal web e apri la vista Transactions del conto.", "Cerca l''opzione Export / Download e imposta le date sull''intero anno fiscale.", "Scarica il CSV. Se trovi solo estratti PDF, contatta il supporto Slash e chiedi l''export CSV delle transazioni — esiste."],
    "note_en": "Other clients export this CSV successfully — ask Slash support if you cannot find the button.",
    "note_it": "Altri clienti esportano questo CSV senza problemi — chiedi al supporto Slash se non trovi il pulsante.",
    "source": "https://www.slash.com/help-center/account-management/accessing-bank-documents-and-deposit-details-on-slash"
  }'),
  ('bank_export_guides', 'airwallex', 'Airwallex', '{
    "match_terms": ["airwallex"],
    "steps_en": ["Log in to the Airwallex web app and open Financial Reports from the left menu.", "Choose Balance Activity Report and click Generate.", "Set the date range January 1 to December 31 and pick the currency (or all currencies).", "Choose CSV and download. If it arrives as a ZIP, unzip it and upload each file here."],
    "steps_it": ["Accedi all''app web Airwallex e apri Financial Reports dal menu a sinistra.", "Scegli Balance Activity Report e clicca Generate.", "Imposta il periodo dal 1 gennaio al 31 dicembre e scegli la valuta (o tutte).", "Scegli CSV e scarica. Se arriva come ZIP, estrailo e carica qui ogni file."],
    "note_en": "Use the Balance Activity Report — the normal account statement is PDF only.",
    "note_it": "Usa il Balance Activity Report — il normale estratto conto è solo PDF.",
    "source": "https://www.airwallex.com/docs/global-treasury/reporting/financial-reports/balance-activity-report"
  }'),
  ('bank_export_guides', 'chase', 'Chase', '{
    "match_terms": ["chase", "jpmorgan", "jp morgan"],
    "steps_en": ["Sign in at chase.com, open the business account and click See all transactions.", "Click the Download icon above the transactions list.", "Choose a custom date range: January 1 to December 31, and set File type to Spreadsheet (Excel, CSV).", "Download. IMPORTANT: if the file looks cut off, download quarter by quarter (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec) and upload all four files here."],
    "steps_it": ["Accedi a chase.com, apri il conto business e clicca See all transactions.", "Clicca l''icona Download sopra la lista delle transazioni.", "Scegli un periodo personalizzato: dal 1 gennaio al 31 dicembre, e imposta File type su Spreadsheet (Excel, CSV).", "Scarica. IMPORTANTE: se il file sembra tagliato, scarica trimestre per trimestre (gen-mar, apr-giu, lug-set, ott-dic) e carica qui tutti e quattro i file."],
    "note_en": "Chase can cut long exports (about 1,000 rows) — quarterly downloads are the safe way for busy accounts.",
    "note_it": "Chase può tagliare gli export lunghi (circa 1.000 righe) — per conti movimentati scarica per trimestri.",
    "source": "https://www.chase.com/content/dam/chase-ux/documents/commercial-banking/chase-connect/cc_quickguide_account_activity.pdf"
  }'),
  ('bank_export_guides', 'paypal', 'PayPal', '{
    "match_terms": ["paypal", "pay pal"],
    "steps_en": ["Log in to PayPal Business, click Activity in the top menu, then All Reports.", "In the left menu choose Activity download.", "Set Transaction type to Balance affecting, and the custom date range January 1 to December 31.", "Choose CSV and click Create Report; wait for the button to change to Download, then download. If it arrives as a ZIP, unzip and upload each file here."],
    "steps_it": ["Accedi a PayPal Business, clicca Activity nel menu in alto, poi All Reports.", "Nel menu a sinistra scegli Activity download.", "Imposta Transaction type su Balance affecting e il periodo personalizzato dal 1 gennaio al 31 dicembre.", "Scegli CSV e clicca Create Report; aspetta che il pulsante diventi Download, poi scarica. Se arriva come ZIP, estrailo e carica qui ogni file."],
    "note_en": "The report can take a few minutes to generate — that is normal.",
    "note_it": "Il report può impiegare qualche minuto a generarsi — è normale.",
    "source": "https://www.paypal.com/us/cshelp/article/help145"
  }')
) AS v(catalog_id, slug, display_name, metadata)
WHERE NOT EXISTS (
  SELECT 1 FROM public.catalog_entries c
  WHERE c.catalog_id = v.catalog_id AND c.slug = v.slug
);
