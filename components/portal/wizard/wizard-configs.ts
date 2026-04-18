/**
 * Wizard step/field configurations for each form type.
 * Matches the exact fields from the existing external forms.
 */

import type { WizardStep } from './wizard-shell'
import type { FieldConfig } from './wizard-field'

// ─── Owner Info Fields (shared across formation/onboarding) ───

const OWNER_FIELDS: FieldConfig[] = [
  { name: 'owner_first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
  { name: 'owner_last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
  { name: 'owner_email', label: 'Email', type: 'email', required: true },
  { name: 'owner_phone', label: 'Phone', labelIt: 'Telefono', type: 'tel', required: true },
  { name: 'owner_dob', label: 'Date of Birth', labelIt: 'Data di Nascita', type: 'date', required: true },
  { name: 'owner_nationality', label: 'Nationality', labelIt: 'Nazionalità', type: 'country', required: true },
  { name: 'owner_street', label: 'Street Address', labelIt: 'Indirizzo', type: 'text', required: true },
  { name: 'owner_city', label: 'City', labelIt: 'Città', type: 'text', required: true },
  { name: 'owner_state_province', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: true },
  { name: 'owner_zip', label: 'ZIP/Postal Code', labelIt: 'CAP', type: 'text', required: true },
  { name: 'owner_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
]

// ─── MEMBER FIELDS (shared for MMLLC formation/onboarding) ──

export const MEMBER_FIELDS: FieldConfig[] = [
  { name: 'member_first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
  { name: 'member_last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
  { name: 'member_email', label: 'Email', type: 'email', required: true },
  { name: 'member_ownership_pct', label: 'Ownership %', labelIt: 'Quota %', type: 'number', required: true },
  { name: 'member_dob', label: 'Date of Birth', labelIt: 'Data di Nascita', type: 'date', required: true },
  { name: 'member_nationality', label: 'Nationality', labelIt: 'Nazionalità', type: 'country', required: true },
  { name: 'member_street', label: 'Street Address', labelIt: 'Indirizzo', type: 'text', required: true },
  { name: 'member_city', label: 'City', labelIt: 'Città', type: 'text', required: true },
  { name: 'member_state_province', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: false },
  { name: 'member_zip', label: 'ZIP Code', labelIt: 'CAP', type: 'text', required: true },
  { name: 'member_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
]

// ─── FORMATION ─────────────────────────────────────────────

export const FORMATION_STEPS: WizardStep[] = [
  { id: 'owner', title: 'Owner Information', titleIt: 'Informazioni Titolare', description: 'Personal details of the LLC owner', descriptionIt: 'Dati personali del titolare della LLC' },
  { id: 'llc', title: 'LLC Details', titleIt: 'Dettagli LLC', description: 'Choose your company name and business purpose', descriptionIt: 'Scegli il nome della società e lo scopo aziendale' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload required documents and review your information', descriptionIt: 'Carica i documenti necessari e rivedi le informazioni' },
]

export const FORMATION_STEPS_MMLLC: WizardStep[] = [
  FORMATION_STEPS[0],
  FORMATION_STEPS[1],
  { id: 'members', title: 'Additional Members', titleIt: 'Membri Aggiuntivi', description: 'Add the other LLC members', descriptionIt: 'Aggiungi gli altri membri della LLC' },
  FORMATION_STEPS[2],
]

export const FORMATION_FIELDS: Record<string, FieldConfig[]> = {
  owner: OWNER_FIELDS,
  llc: [
    { name: 'llc_name_1', label: '1st Choice Company Name', labelIt: 'Nome Società (1ª scelta)', type: 'text', required: true, hint: 'Must end with LLC', hintIt: 'Deve terminare con LLC' },
    { name: 'llc_name_2', label: '2nd Choice (backup)', labelIt: 'Nome Società (2ª scelta)', type: 'text', required: true, hint: 'In case the first name is taken', hintIt: 'Nel caso il primo nome sia già registrato' },
    { name: 'llc_name_3', label: '3rd Choice (backup)', labelIt: 'Nome Società (3ª scelta)', type: 'text', required: true },
    { name: 'business_purpose', label: 'Business Purpose', labelIt: 'Scopo Aziendale', type: 'textarea', required: true, hint: 'Describe the main activities of the LLC', hintIt: 'Descrivi le attività principali della LLC' },
  ],
  members: MEMBER_FIELDS,
  documents: [
    { name: 'passport_owner', label: 'Passport Scan (Owner)', labelIt: 'Scansione Passaporto (Titolare)', type: 'file', required: true, hint: 'Clear photo of passport data page', hintIt: 'Foto chiara della pagina dati del passaporto' },
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
  ],
}

// ─── ONBOARDING ────────────────────────────────────────────

export const ONBOARDING_STEPS: WizardStep[] = [
  { id: 'owner', title: 'Owner Information', titleIt: 'Informazioni Titolare', description: 'Personal details', descriptionIt: 'Dati personali' },
  { id: 'company', title: 'Company Information', titleIt: 'Informazioni Società', description: 'Your existing LLC details', descriptionIt: 'Dettagli della tua LLC esistente' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload required documents', descriptionIt: 'Carica i documenti necessari' },
]

export const ONBOARDING_STEPS_MMLLC: WizardStep[] = [
  ONBOARDING_STEPS[0],
  ONBOARDING_STEPS[1],
  { id: 'members', title: 'Additional Members', titleIt: 'Membri Aggiuntivi', description: 'Add the other LLC members', descriptionIt: 'Aggiungi gli altri membri della LLC' },
  ONBOARDING_STEPS[2],
]

export const ONBOARDING_FIELDS: Record<string, FieldConfig[]> = {
  owner: [
    ...OWNER_FIELDS,
    { name: 'owner_itin', label: 'ITIN (if available)', labelIt: 'ITIN (se disponibile)', type: 'text', required: false },
    { name: 'owner_itin_issue_date', label: 'ITIN Issue Date', labelIt: 'Data Emissione ITIN', type: 'date', required: false },
  ],
  company: [
    { name: 'company_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true },
    { name: 'state_of_formation', label: 'State of Formation', labelIt: 'Stato di Costituzione', type: 'select', required: true, options: [
      { value: 'Alabama', label: 'Alabama' }, { value: 'Alaska', label: 'Alaska' },
      { value: 'Arizona', label: 'Arizona' }, { value: 'Arkansas', label: 'Arkansas' },
      { value: 'California', label: 'California' }, { value: 'Colorado', label: 'Colorado' },
      { value: 'Connecticut', label: 'Connecticut' }, { value: 'Delaware', label: 'Delaware' },
      { value: 'Florida', label: 'Florida' }, { value: 'Georgia', label: 'Georgia' },
      { value: 'Hawaii', label: 'Hawaii' }, { value: 'Idaho', label: 'Idaho' },
      { value: 'Illinois', label: 'Illinois' }, { value: 'Indiana', label: 'Indiana' },
      { value: 'Iowa', label: 'Iowa' }, { value: 'Kansas', label: 'Kansas' },
      { value: 'Kentucky', label: 'Kentucky' }, { value: 'Louisiana', label: 'Louisiana' },
      { value: 'Maine', label: 'Maine' }, { value: 'Maryland', label: 'Maryland' },
      { value: 'Massachusetts', label: 'Massachusetts' }, { value: 'Michigan', label: 'Michigan' },
      { value: 'Minnesota', label: 'Minnesota' }, { value: 'Mississippi', label: 'Mississippi' },
      { value: 'Missouri', label: 'Missouri' }, { value: 'Montana', label: 'Montana' },
      { value: 'Nebraska', label: 'Nebraska' }, { value: 'Nevada', label: 'Nevada' },
      { value: 'New Hampshire', label: 'New Hampshire' }, { value: 'New Jersey', label: 'New Jersey' },
      { value: 'New Mexico', label: 'New Mexico' }, { value: 'New York', label: 'New York' },
      { value: 'North Carolina', label: 'North Carolina' }, { value: 'North Dakota', label: 'North Dakota' },
      { value: 'Ohio', label: 'Ohio' }, { value: 'Oklahoma', label: 'Oklahoma' },
      { value: 'Oregon', label: 'Oregon' }, { value: 'Pennsylvania', label: 'Pennsylvania' },
      { value: 'Rhode Island', label: 'Rhode Island' }, { value: 'South Carolina', label: 'South Carolina' },
      { value: 'South Dakota', label: 'South Dakota' }, { value: 'Tennessee', label: 'Tennessee' },
      { value: 'Texas', label: 'Texas' }, { value: 'Utah', label: 'Utah' },
      { value: 'Vermont', label: 'Vermont' }, { value: 'Virginia', label: 'Virginia' },
      { value: 'Washington', label: 'Washington' }, { value: 'West Virginia', label: 'West Virginia' },
      { value: 'Wisconsin', label: 'Wisconsin' }, { value: 'Wyoming', label: 'Wyoming' },
    ]},
    { name: 'formation_date', label: 'Formation Date', labelIt: 'Data Costituzione', type: 'date', required: true },
    { name: 'ein', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein', hint: 'e.g. 30-1482516' },
    { name: 'filing_id', label: 'State Filing ID', labelIt: 'Filing ID Statale', type: 'text', required: false },
    { name: 'business_purpose', label: 'Business Activities', labelIt: 'Attività Aziendali', type: 'textarea', required: true },
    { name: 'registered_agent', label: 'Current Registered Agent', labelIt: 'Agente Registrato Attuale', type: 'text', required: false },
    { name: 'tax_return_previous_year_filed', label: 'Previous Year Tax Return Filed?', labelIt: 'Dichiarazione anno precedente presentata?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
      { value: 'No', label: 'No' },
      { value: 'Not sure', label: 'Not sure', labelIt: 'Non sono sicuro' },
    ]},
    { name: 'tax_return_current_year_filed', label: 'Current Year Tax Return Filed?', labelIt: 'Dichiarazione anno corrente presentata?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
      { value: 'No', label: 'No' },
      { value: 'Not sure', label: 'Not sure', labelIt: 'Non sono sicuro' },
    ]},
  ],
  members: MEMBER_FIELDS,
  documents: [
    { name: 'passport_owner', label: 'Passport Scan (Owner)', labelIt: 'Scansione Passaporto (Titolare)', type: 'file', required: true },
    { name: 'articles_of_organization', label: 'Articles of Organization', labelIt: 'Atto Costitutivo', type: 'file', required: true },
    { name: 'ein_letter', label: 'EIN Letter (CP 575)', labelIt: 'Lettera EIN (CP 575)', type: 'file', required: true },
    { name: 'ss4_form', label: 'SS-4 Form (optional)', labelIt: 'Modulo SS-4 (opzionale)', type: 'file', required: false },
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
  ],
}

// ─── TAX RETURN ────────────────────────────────────────────

// Shared owner fields for all tax entity types
const TAX_OWNER_BASE: FieldConfig[] = [
  { name: 'owner_first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
  { name: 'owner_last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
  { name: 'owner_email', label: 'Email', type: 'email', required: true },
  { name: 'owner_phone', label: 'Phone', labelIt: 'Telefono', type: 'tel', required: true },
  { name: 'owner_street', label: 'Street Address', labelIt: 'Indirizzo', type: 'text', required: true },
  { name: 'owner_city', label: 'City', labelIt: 'Città', type: 'text', required: true },
  { name: 'owner_state_province', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: true },
  { name: 'owner_zip', label: 'ZIP/Postal Code', labelIt: 'CAP', type: 'text', required: true },
  { name: 'owner_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
  { name: 'owner_tax_residency', label: 'Tax Residency Country', labelIt: 'Residenza Fiscale', type: 'country', required: true },
  { name: 'owner_local_tax_number', label: 'Local Tax ID (VAT/Codice Fiscale)', labelIt: 'Codice Fiscale / P.IVA', type: 'text', required: true },
]

// Shared company fields
const TAX_COMPANY_BASE: FieldConfig[] = [
  { name: 'llc_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true },
  { name: 'ein_number', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein' },
  { name: 'date_of_incorporation', label: 'Date of Incorporation', labelIt: 'Data Costituzione', type: 'date', required: true },
  { name: 'state_of_incorporation', label: 'State of Incorporation', labelIt: 'Stato Costituzione', type: 'text', required: true },
  { name: 'principal_product_service', label: 'Principal Product/Service', labelIt: 'Prodotto/Servizio Principale', type: 'textarea', required: true },
  { name: 'us_business_activities', label: 'US Business Activities', labelIt: 'Attività Commerciali USA', type: 'textarea', required: true },
  { name: 'website_url', label: 'Website (optional)', labelIt: 'Sito Web (opzionale)', type: 'text', required: false },
]

// Shared document fields for MMLLC / Corp (bank statements required)
const TAX_DOCUMENTS_BASE: FieldConfig[] = [
  { name: 'bank_statements', label: 'Bank Statements (CSV preferred)', labelIt: 'Estratti Conto (CSV preferito)', type: 'file', required: true, hint: 'Upload all bank statements for the tax year', hintIt: 'Carica tutti gli estratti conto dell\'anno fiscale' },
  { name: 'financial_statements', label: 'Financial Statements (optional)', labelIt: 'Rendiconti Finanziari (opzionale)', type: 'file', required: false },
  { name: 'prior_year_return', label: 'Prior Year Tax Return (optional)', labelIt: 'Dichiarazione Anno Precedente (opzionale)', type: 'file', required: false },
  { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
]

// ─── TAX SMLLC documents (all optional — different from MMLLC/Corp) ──

const TAX_SMLLC_DOCUMENTS: FieldConfig[] = [
  { name: 'bank_statements', label: 'Bank Statements (optional)', labelIt: 'Estratti Conto (opzionale)', type: 'file', required: false, accept: '.pdf,.csv,.jpg,.jpeg,.png', hint: 'Optional. Upload bank statements for the tax year if available. CSV format is welcome but not required.', hintIt: 'Facoltativo. Carica gli estratti conto dell\'anno fiscale se disponibili. Il formato CSV è benvenuto ma non obbligatorio.' },
  { name: 'financial_statements', label: 'Financial Statements (optional)', labelIt: 'Rendiconti Finanziari (opzionale)', type: 'file', required: false, hint: 'Optional. Profit & loss statement or balance sheet if your accountant has prepared one.', hintIt: 'Facoltativo. Conto economico o stato patrimoniale se il tuo commercialista ne ha preparato uno.' },
  { name: 'prior_year_return', label: 'Prior Year Tax Return (optional)', labelIt: 'Dichiarazione Anno Precedente (opzionale)', type: 'file', required: false, hint: 'Optional. Upload last year\'s filed tax return (Form 5472 or 1120) if available.', hintIt: 'Facoltativo. Carica la dichiarazione dell\'anno scorso (Modulo 5472 o 1120) se disponibile.' },
  { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
]

// ─── TAX SMLLC (Form 1120/5472) ───────────────────────────

export const TAX_STEPS: WizardStep[] = [
  { id: 'owner', title: 'Owner Information', titleIt: 'Informazioni Titolare', description: 'Personal and tax details', descriptionIt: 'Dati personali e fiscali' },
  { id: 'company', title: 'Company Information', titleIt: 'Informazioni Società', description: 'Your LLC details', descriptionIt: 'Dettagli della tua LLC' },
  { id: 'financials', title: 'Financial Information', titleIt: 'Informazioni Finanziarie', description: 'Income, expenses, and transactions', descriptionIt: 'Entrate, spese e transazioni' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload documents and review', descriptionIt: 'Carica documenti e rivedi' },
]

export const TAX_FIELDS: Record<string, FieldConfig[]> = {
  owner: [
    ...TAX_OWNER_BASE,
    // SMLLC-specific: 5472 ownership questions
    { name: 'owner_direct_100_pct', label: 'Are you the 100% direct owner?', labelIt: 'Sei il proprietario diretto al 100%?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ], hint: 'Answer "Yes" if you personally own 100% of this LLC with no other owner or holding company above you. Answer "No" if another company or person also holds an ownership interest.', hintIt: 'Rispondi "Sì" se possiedi personalmente il 100% di questa LLC. Rispondi "No" se un\'altra società o persona detiene anche una quota.' },
    { name: 'owner_ultimate_25_pct', label: 'Is there an ultimate owner with more than 25% interest?', labelIt: 'C\'è un proprietario finale con più del 25% di interesse?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ], hint: 'The "ultimate beneficial owner" is the real person (not a company) at the top of the ownership chain who owns or controls the LLC. Answer "Yes" if that person holds more than 25%.', hintIt: 'Il "proprietario finale" è la persona fisica (non una società) in cima alla catena proprietaria. Rispondi "Sì" se quella persona detiene più del 25%.' },
    { name: 'ultimate_owner_name', label: 'Ultimate Owner Name', labelIt: 'Nome Proprietario Finale', type: 'text', required: false, conditional: { field: 'owner_ultimate_25_pct', value: 'Yes' }, hint: 'Full legal name of the ultimate beneficial owner (the real person at the top of the ownership chain).', hintIt: 'Nome legale completo del proprietario finale (la persona fisica in cima alla catena proprietaria).' },
    { name: 'ultimate_owner_address', label: 'Ultimate Owner Address', labelIt: 'Indirizzo Proprietario Finale', type: 'text', required: false, conditional: { field: 'owner_ultimate_25_pct', value: 'Yes' }, hint: 'Full residential or registered address of the ultimate beneficial owner.', hintIt: 'Indirizzo residenziale o registrato completo del proprietario finale.' },
    { name: 'ultimate_owner_country', label: 'Ultimate Owner Country', labelIt: 'Paese Proprietario Finale', type: 'country', required: false, conditional: { field: 'owner_ultimate_25_pct', value: 'Yes' } },
    { name: 'ultimate_owner_tax_id', label: 'Ultimate Owner Tax ID', labelIt: 'Codice Fiscale Proprietario Finale', type: 'text', required: false, conditional: { field: 'owner_ultimate_25_pct', value: 'Yes' }, hint: 'Tax identification number in the owner\'s country of residence (e.g., Codice Fiscale for Italy, NIF for Spain).', hintIt: 'Codice fiscale nel paese di residenza del proprietario (es. Codice Fiscale per l\'Italia).' },
  ],
  company: TAX_COMPANY_BASE,
  financials: [
    { name: 'formation_costs', label: 'Formation Costs ($)', labelIt: 'Costi di Costituzione ($)', type: 'number', required: true, hint: 'Total amount paid to form the LLC: state filing fees, registered agent fees, attorney/service fees. Enter 0 if already deducted in a prior year.', hintIt: 'Importo totale pagato per costituire la LLC: tasse statali, agente registrato, avvocato/servizio. Inserisci 0 se già dedotto in un anno precedente.' },
    { name: 'bank_contributions', label: 'Bank Contributions ($)', labelIt: 'Conferimenti Bancari ($)', type: 'number', required: true, hint: 'Total money you personally deposited or wired INTO the LLC bank account during the year (capital contributions, not revenue).', hintIt: 'Denaro totale che hai depositato o trasferito SUL conto bancario della LLC durante l\'anno (conferimenti di capitale, non ricavi).' },
    { name: 'distributions_withdrawals', label: 'Distributions / Withdrawals ($)', labelIt: 'Distribuzioni / Prelievi ($)', type: 'number', required: true, hint: 'Total money you took OUT of the LLC bank account for personal use during the year.', hintIt: 'Denaro totale che hai prelevato dal conto bancario della LLC per uso personale durante l\'anno.' },
    { name: 'personal_expenses', label: 'Personal Expenses Paid by LLC ($)', labelIt: 'Spese Personali Pagate dalla LLC ($)', type: 'number', required: true, hint: 'Total personal (non-business) expenses paid from the LLC account. Examples: personal travel, personal subscriptions, gifts. Enter 0 if none.', hintIt: 'Spese personali (non aziendali) pagate dal conto della LLC. Esempi: viaggi personali, abbonamenti personali, regali. Inserisci 0 se nessuna.' },
    {
      name: 'related_party_transactions',
      label: 'Related Party Transactions',
      labelIt: 'Transazioni con Parti Correlate',
      type: 'repeater',
      required: false,
      hint: 'Required for Form 5472: list any transactions between your LLC and a related foreign person or entity (e.g., payments to/from a foreign company you own, or that owns you). Leave empty if none.',
      hintIt: 'Obbligatorio per il Modulo 5472: elenca le transazioni tra la tua LLC e una persona o entità straniera correlata. Lascia vuoto se nessuna.',
      repeaterFields: [
        { name: 'rpt_company_name', label: 'Company / Person Name', labelIt: 'Nome Società / Persona', type: 'text', required: true, hint: 'Legal name of the related foreign company or person.', hintIt: 'Nome legale della società o persona straniera correlata.' },
        { name: 'rpt_address', label: 'Address', labelIt: 'Indirizzo', type: 'text', required: true },
        { name: 'rpt_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
        { name: 'rpt_vat_number', label: 'VAT / Foreign Tax ID', labelIt: 'P.IVA / Codice Fiscale Estero', type: 'text', required: false, hint: 'Tax identification number in the other party\'s country. Optional but recommended.', hintIt: 'Numero di identificazione fiscale nel paese della controparte. Facoltativo ma consigliato.' },
        { name: 'rpt_amount', label: 'Transaction Amount ($)', labelIt: 'Importo Transazione ($)', type: 'number', required: true, hint: 'Total USD value of transactions with this party for the year. Use the exchange rate at the time of the transaction.', hintIt: 'Valore totale in USD delle transazioni con questa parte per l\'anno.' },
        { name: 'rpt_description', label: 'Description', labelIt: 'Descrizione', type: 'textarea', required: false, hint: 'Describe the nature of the transaction (e.g., "Service fee paid for consulting", "Loan from parent company", "Royalty payment").', hintIt: 'Descrivi la natura della transazione (es. "Commissione di servizio per consulenza", "Prestito dalla società madre").' },
      ],
      repeaterAddLabel: 'Add related party transaction',
      repeaterAddLabelIt: 'Aggiungi transazione con parte correlata',
    },
    { name: 'smllc_additional_comments', label: 'Additional Comments', labelIt: 'Commenti Aggiuntivi', type: 'textarea', required: false, hint: 'Any other financial details, unusual transactions, or information you think is relevant for your tax return.', hintIt: 'Qualsiasi altro dettaglio finanziario, transazione insolita o informazione che ritieni rilevante per la tua dichiarazione.' },
  ],
  documents: TAX_SMLLC_DOCUMENTS,
}

// ─── TAX MMLLC / Partnership (Form 1065) ──────────────────

export const TAX_MMLLC_STEPS: WizardStep[] = [
  { id: 'owner', title: 'Owner & Members', titleIt: 'Titolare e Membri', description: 'All partners/members details', descriptionIt: 'Dettagli di tutti i soci/membri' },
  { id: 'company', title: 'Company Information', titleIt: 'Informazioni Società', description: 'Your LLC details', descriptionIt: 'Dettagli della tua LLC' },
  { id: 'financials', title: 'Financial Information', titleIt: 'Informazioni Finanziarie', description: 'Partnership financial details', descriptionIt: 'Dettagli finanziari della partnership' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload statements and review', descriptionIt: 'Carica estratti conto e rivedi' },
]

export const TAX_MMLLC_FIELDS: Record<string, FieldConfig[]> = {
  owner: [
    ...TAX_OWNER_BASE,
    // MMLLC members are added dynamically via repeater
  ],
  company: [
    ...TAX_COMPANY_BASE,
    { name: 'has_payroll_w2', label: 'Does the LLC have payroll / W-2 employees?', labelIt: 'La LLC ha dipendenti / W-2?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'payroll_details', label: 'Payroll Details (if applicable)', labelIt: 'Dettagli Payroll (se applicabile)', type: 'textarea', required: false },
  ],
  financials: [
    { name: 'prior_year_returns_filed', label: 'Prior Year Returns Filed?', labelIt: 'Dichiarazioni anno precedente presentate?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'financial_statements_sent', label: 'Financial Statements Prepared?', labelIt: 'Rendiconti finanziari preparati?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_ownership_change', label: 'Any ownership changes during the year?', labelIt: 'Cambiamenti nella proprietà durante l\'anno?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_foreign_partners', label: 'Any foreign partners?', labelIt: 'Soci stranieri?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_assets_over_50k', label: 'Total assets over $50,000?', labelIt: 'Attivi totali superiori a $50.000?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_received_1099', label: 'Received any 1099 forms?', labelIt: 'Ricevuti moduli 1099?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_issued_1099', label: 'Issued any 1099 forms?', labelIt: 'Emessi moduli 1099?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_crypto_transactions', label: 'Any cryptocurrency transactions?', labelIt: 'Transazioni in criptovaluta?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_real_estate', label: 'Any real estate owned?', labelIt: 'Immobili di proprietà?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_foreign_bank_accounts', label: 'Foreign bank accounts (FBAR)?', labelIt: 'Conti bancari esteri (FBAR)?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_related_party_trans', label: 'Related party transactions?', labelIt: 'Transazioni con parti correlate?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_debt_forgiveness', label: 'Any debt forgiveness?', labelIt: 'Cancellazione di debiti?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_vehicle_business_use', label: 'Vehicle used for business?', labelIt: 'Veicolo usato per l\'attività?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_home_office', label: 'Home office deduction?', labelIt: 'Deduzione ufficio in casa?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_retirement_plan', label: 'Retirement plan contributions?', labelIt: 'Contributi piano pensionistico?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_health_insurance', label: 'Health insurance for partners?', labelIt: 'Assicurazione sanitaria per i soci?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'mmllc_additional_info', label: 'Additional Information', labelIt: 'Informazioni Aggiuntive', type: 'textarea', required: false },
  ],
  documents: TAX_DOCUMENTS_BASE,
}

// ─── TAX CORP / Elected C-Corp (Form 1120) ────────────────

export const TAX_CORP_STEPS: WizardStep[] = [
  { id: 'owner', title: 'Ownership & Directors', titleIt: 'Proprietà e Amministratori', description: 'Corporate ownership structure', descriptionIt: 'Struttura proprietaria della società' },
  { id: 'company', title: 'Company Information', titleIt: 'Informazioni Società', description: 'Corporation details', descriptionIt: 'Dettagli della società' },
  { id: 'financials', title: 'Financial Information', titleIt: 'Informazioni Finanziarie', description: 'Corporate financial details', descriptionIt: 'Dettagli finanziari della società' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload statements and review', descriptionIt: 'Carica estratti conto e rivedi' },
]

export const TAX_CORP_FIELDS: Record<string, FieldConfig[]> = {
  owner: [
    ...TAX_OWNER_BASE,
    { name: 'ownership_structure', label: 'Ownership Structure (describe all shareholders)', labelIt: 'Struttura Proprietaria (descrivi tutti gli azionisti)', type: 'textarea', required: true },
    { name: 'foreign_owned_25_pct', label: 'Foreign ownership >= 25%?', labelIt: 'Proprietà estera >= 25%?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'foreign_owner_details', label: 'Foreign Owner Details (if applicable)', labelIt: 'Dettagli Proprietario Estero (se applicabile)', type: 'textarea', required: false },
  ],
  company: [
    ...TAX_COMPANY_BASE,
    { name: 'has_payroll_w2', label: 'Does the corporation have payroll / W-2 employees?', labelIt: 'La società ha dipendenti / W-2?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'payroll_details', label: 'Payroll Details', labelIt: 'Dettagli Payroll', type: 'textarea', required: false },
    { name: 'state_revenue_breakdown', label: 'Revenue by State (if multi-state)', labelIt: 'Fatturato per Stato (se multi-stato)', type: 'textarea', required: false },
    { name: 'new_activities_markets', label: 'New Activities or Markets This Year', labelIt: 'Nuove Attività o Mercati Quest\'Anno', type: 'textarea', required: false },
  ],
  financials: [
    { name: 'corp_contributions', label: 'Capital Contributions ($)', labelIt: 'Conferimenti di Capitale ($)', type: 'number', required: false },
    { name: 'corp_distributions', label: 'Distributions ($)', labelIt: 'Distribuzioni ($)', type: 'number', required: false },
    { name: 'corp_dividends_paid', label: 'Dividends Paid ($)', labelIt: 'Dividendi Pagati ($)', type: 'number', required: false },
    { name: 'corp_estimated_taxes_paid', label: 'Estimated Taxes Paid ($)', labelIt: 'Tasse Stimate Pagate ($)', type: 'number', required: false },
    { name: 'corp_rental_passive_income', label: 'Rental/Passive Income ($)', labelIt: 'Reddito da Affitto/Passivo ($)', type: 'number', required: false },
    { name: 'corp_debt_modifications', label: 'Debt Modifications or Forgiveness', labelIt: 'Modifiche o Cancellazione Debiti', type: 'textarea', required: false },
    { name: 'corp_minute_book_updated', label: 'Corporate Minute Book Updated?', labelIt: 'Libro dei Verbali Aggiornato?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'corp_received_1099', label: 'Received any 1099 forms?', labelIt: 'Ricevuti moduli 1099?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'corp_vehicle_ownership', label: 'Company-owned vehicles?', labelIt: 'Veicoli di proprietà della società?', type: 'select', required: false, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' }, { value: 'No', label: 'No' },
    ]},
    { name: 'corp_additional_info', label: 'Additional Information', labelIt: 'Informazioni Aggiuntive', type: 'textarea', required: false },
  ],
  documents: TAX_DOCUMENTS_BASE,
}

// ─── ITIN ──────────────────────────────────────────────────

export const ITIN_STEPS: WizardStep[] = [
  { id: 'personal', title: 'Personal Information', titleIt: 'Informazioni Personali', description: 'W-7 application details', descriptionIt: 'Dati per la richiesta W-7' },
  { id: 'address', title: 'Address & Passport', titleIt: 'Indirizzo e Passaporto', description: 'Foreign address and entry information', descriptionIt: 'Indirizzo estero e informazioni di ingresso' },
  { id: 'review', title: 'Review & Submit', titleIt: 'Revisione e Invio', description: 'Review your information and submit', descriptionIt: 'Rivedi le informazioni e invia' },
]

export const ITIN_FIELDS: Record<string, FieldConfig[]> = {
  personal: [
    { name: 'first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
    { name: 'last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
    { name: 'name_at_birth', label: 'Name at Birth (if different)', labelIt: 'Nome alla Nascita (se diverso)', type: 'text', required: false, hint: 'Only if your birth name differs from your current legal name', hintIt: 'Solo se il nome alla nascita è diverso dal nome legale attuale' },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'phone', label: 'Phone', labelIt: 'Telefono', type: 'tel', required: true },
    { name: 'dob', label: 'Date of Birth', labelIt: 'Data di Nascita', type: 'date', required: true },
    { name: 'country_of_birth', label: 'Country of Birth', labelIt: 'Paese di Nascita', type: 'country', required: true },
    { name: 'city_of_birth', label: 'City of Birth', labelIt: 'Città di Nascita', type: 'text', required: true },
    { name: 'gender', label: 'Gender', labelIt: 'Sesso', type: 'select', required: true, options: [
      { value: 'Male', label: 'Male', labelIt: 'Maschio' },
      { value: 'Female', label: 'Female', labelIt: 'Femmina' },
    ]},
    { name: 'citizenship', label: 'Citizenship', labelIt: 'Cittadinanza', type: 'country', required: true },
  ],
  address: [
    { name: 'foreign_street', label: 'Foreign Street Address', labelIt: 'Indirizzo Estero', type: 'text', required: true },
    { name: 'foreign_city', label: 'City', labelIt: 'Città', type: 'text', required: true },
    { name: 'foreign_state_province', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: false },
    { name: 'foreign_zip', label: 'ZIP/Postal Code', labelIt: 'CAP', type: 'text', required: true },
    { name: 'foreign_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
    { name: 'foreign_tax_id', label: 'Foreign Tax ID (optional)', labelIt: 'Codice Fiscale Estero (opzionale)', type: 'text', required: false, hint: 'e.g. Codice Fiscale for Italy', hintIt: 'es. Codice Fiscale' },
    { name: 'has_us_visa', label: 'Do you have a US visa?', labelIt: 'Hai un visto USA?', type: 'select', required: true, options: [
      { value: 'No', label: 'No' },
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    ]},
    { name: 'us_visa_type', label: 'US Visa Type', labelIt: 'Tipo di Visto USA', type: 'text', required: true, conditional: { field: 'has_us_visa', value: 'Yes' }, hint: 'e.g. B1, B2, F1, H1B', hintIt: 'es. B1, B2, F1, H1B' },
    { name: 'us_visa_number', label: 'US Visa Number', labelIt: 'Numero Visto USA', type: 'text', required: true, conditional: { field: 'has_us_visa', value: 'Yes' } },
    { name: 'us_entry_date', label: 'Date of US Entry', labelIt: 'Data di Ingresso negli USA', type: 'date', required: false, conditional: { field: 'has_us_visa', value: 'Yes' } },
    { name: 'passport_number', label: 'Passport Number', labelIt: 'Numero Passaporto', type: 'text', required: true },
    { name: 'passport_country', label: 'Passport Country', labelIt: 'Paese del Passaporto', type: 'country', required: true },
    { name: 'passport_expiry', label: 'Passport Expiry Date', labelIt: 'Scadenza Passaporto', type: 'date', required: true },
    { name: 'has_previous_itin', label: 'Do you have a previous ITIN?', labelIt: 'Hai un ITIN precedente?', type: 'select', required: true, options: [
      { value: 'No', label: 'No' },
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    ]},
    { name: 'previous_itin', label: 'Previous ITIN Number', labelIt: 'Numero ITIN Precedente', type: 'text', required: true, conditional: { field: 'has_previous_itin', value: 'Yes' } },
  ],
  review: [
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate and I understand the passport must be mailed physically', labelIt: 'Confermo che le informazioni sono corrette e comprendo che il passaporto deve essere spedito fisicamente', type: 'checkbox', required: true },
  ],
}

// ─── BANKING (Payset EUR + Relay USD) ─────────────────────

export const BANKING_PAYSET_STEPS: WizardStep[] = [
  { id: 'personal', title: 'Personal Information', titleIt: 'Informazioni Personali', description: 'Your personal details', descriptionIt: 'I tuoi dati personali' },
  { id: 'business', title: 'Business Information & Documents', titleIt: 'Informazioni Aziendali e Documenti', description: 'Business details and required documents', descriptionIt: 'Dettagli aziendali e documenti richiesti' },
]

export const BANKING_PAYSET_FIELDS: Record<string, FieldConfig[]> = {
  personal: [
    { name: 'first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
    { name: 'last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
    { name: 'personal_street', label: 'Street Address', labelIt: 'Indirizzo', type: 'text', required: true },
    { name: 'personal_city', label: 'City', labelIt: 'Città', type: 'text', required: true },
    { name: 'personal_state_province', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: true },
    { name: 'personal_zip', label: 'ZIP/Postal Code', labelIt: 'CAP', type: 'text', required: true },
    { name: 'personal_country', label: 'Country of Residence', labelIt: 'Paese di Residenza', type: 'country', required: true },
  ],
  business: [
    { name: 'business_name', label: 'Business Name (LLC)', labelIt: 'Nome Azienda (LLC)', type: 'text', required: true },
    { name: 'business_street', label: 'Business Address', labelIt: 'Indirizzo Aziendale', type: 'text', required: true },
    { name: 'business_city', label: 'Business City', labelIt: 'Città Aziendale', type: 'text', required: true },
    { name: 'business_state_province', label: 'Business State/Province', labelIt: 'Stato/Provincia Aziendale', type: 'text', required: true },
    { name: 'business_zip', label: 'Business ZIP', labelIt: 'CAP Aziendale', type: 'text', required: true },
    { name: 'business_country', label: 'Business Country', labelIt: 'Paese Aziendale', type: 'country', required: true },
    { name: 'business_type', label: 'Business Type', labelIt: 'Tipo di Attività', type: 'select', required: true, options: [
      { value: 'Retail', label: 'Retail', labelIt: 'Commercio' },
      { value: 'Manufacturing', label: 'Manufacturing', labelIt: 'Produzione' },
      { value: 'Services', label: 'Services', labelIt: 'Servizi' },
      { value: 'Technology', label: 'Technology', labelIt: 'Tecnologia' },
      { value: 'Marketing', label: 'Marketing' },
      { value: 'Agency', label: 'Agency', labelIt: 'Agenzia' },
      { value: 'E-Commerce', label: 'E-Commerce' },
      { value: 'Business Consulting', label: 'Business Consulting', labelIt: 'Consulenza' },
      { value: 'Finance', label: 'Finance', labelIt: 'Finanza' },
    ]},
    { name: 'us_physical_presence', label: 'US Physical Presence?', labelIt: 'Presenza Fisica USA?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
      { value: 'No', label: 'No' },
    ]},
    { name: 'business_model', label: 'Business Model', labelIt: 'Modello di Business', type: 'select', required: true, options: [
      { value: 'B2B', label: 'B2B' }, { value: 'B2C', label: 'B2C' }, { value: 'C2B', label: 'C2B' },
    ]},
    { name: 'products_services', label: 'Products/Services', labelIt: 'Prodotti/Servizi', type: 'textarea', required: true },
    { name: 'operating_countries', label: 'Operating Countries', labelIt: 'Paesi Operativi', type: 'text', required: true },
    { name: 'website_url', label: 'Website (optional)', labelIt: 'Sito Web (opzionale)', type: 'text', required: false },
    { name: 'phone', label: 'Phone', labelIt: 'Telefono', type: 'tel', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'crypto_transactions', label: 'Cryptocurrency Transactions?', labelIt: 'Transazioni in Criptovaluta?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
      { value: 'No', label: 'No' },
    ]},
    { name: 'monthly_volume', label: 'Expected Monthly Volume (EUR)', labelIt: 'Volume Mensile Previsto (EUR)', type: 'number', required: true },
    { name: 'proof_of_address', label: 'Proof of Address (utility bill or bank statement)', labelIt: 'Prova di Residenza (bolletta o estratto conto)', type: 'file', required: true },
    { name: 'business_bank_statement', label: 'Business Bank Statement (last 3 months)', labelIt: 'Estratto Conto Aziendale (ultimi 3 mesi)', type: 'file', required: true },
    { name: 'disclaimer_accepted', label: 'I confirm that all information is accurate', labelIt: 'Confermo che le informazioni sono corrette', type: 'checkbox', required: true },
  ],
}

export const BANKING_RELAY_STEPS: WizardStep[] = [
  { id: 'business', title: 'Business Information', titleIt: 'Informazioni Aziendali', description: 'Your LLC details', descriptionIt: 'Dettagli della tua LLC' },
  { id: 'owner', title: 'Owner Information & Documents', titleIt: 'Informazioni Titolare e Documenti', description: 'Personal details and documents', descriptionIt: 'Dati personali e documenti' },
  { id: 'partner', title: 'Partner Information', titleIt: 'Informazioni Socio', description: 'If your LLC has additional members', descriptionIt: 'Se la tua LLC ha altri membri' },
]

export const BANKING_RELAY_FIELDS: Record<string, FieldConfig[]> = {
  business: [
    { name: 'business_name', label: 'Business Name (LLC)', labelIt: 'Nome Azienda (LLC)', type: 'text', required: true },
    { name: 'phone', label: 'Phone', labelIt: 'Telefono', type: 'tel', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'ein', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein' },
    { name: 'business_description', label: 'Business Description', labelIt: 'Descrizione Attività', type: 'textarea', required: true, hint: 'Be as detailed as possible — the bank evaluates your business here', hintIt: 'Sii il più dettagliato possibile — la banca valuta la tua attività qui' },
    { name: 'avg_monthly_revenue', label: 'Average Monthly Revenue (USD)', labelIt: 'Fatturato Mensile Medio (USD)', type: 'number', required: true },
    { name: 'other_us_bank', label: 'Other US Bank Account (optional)', labelIt: 'Altro Conto USA (opzionale)', type: 'text', required: false },
  ],
  owner: [
    { name: 'first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
    { name: 'last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
    { name: 'personal_street', label: 'Street Address', labelIt: 'Indirizzo', type: 'text', required: true },
    { name: 'personal_city', label: 'City', labelIt: 'Città', type: 'text', required: true },
    { name: 'personal_state', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: true },
    { name: 'personal_zip', label: 'ZIP/Postal Code', labelIt: 'CAP', type: 'text', required: true },
    { name: 'personal_phone', label: 'Personal Phone', labelIt: 'Telefono Personale', type: 'tel', required: true },
    { name: 'personal_email', label: 'Personal Email', labelIt: 'Email Personale', type: 'email', required: true },
    { name: 'equity_pct', label: 'Ownership %', labelIt: 'Quota Societaria %', type: 'number', required: true },
    { name: 'has_partner', label: 'Do you have a business partner?', labelIt: 'Hai un socio?', type: 'select', required: true, options: [
      { value: 'No', label: 'No' },
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    ]},
    { name: 'passport_image', label: 'Passport Photo (JPG, all 4 corners visible)', labelIt: 'Foto Passaporto (JPG, 4 angoli visibili)', type: 'file', required: true },
    { name: 'proof_of_address', label: 'Proof of Address', labelIt: 'Prova di Residenza', type: 'file', required: true },
    { name: 'disclaimer_accepted', label: 'I confirm that all information is accurate', labelIt: 'Confermo che le informazioni sono corrette', type: 'checkbox', required: true },
  ],
  partner: [
    { name: 'partner_first_name', label: 'Partner First Name', labelIt: 'Nome Socio', type: 'text', required: true },
    { name: 'partner_last_name', label: 'Partner Last Name', labelIt: 'Cognome Socio', type: 'text', required: true },
    { name: 'partner_street', label: 'Partner Address', labelIt: 'Indirizzo Socio', type: 'text', required: true },
    { name: 'partner_city', label: 'Partner City', labelIt: 'Città Socio', type: 'text', required: true },
    { name: 'partner_state', label: 'Partner State', labelIt: 'Stato Socio', type: 'text', required: true },
    { name: 'partner_zip', label: 'Partner ZIP', labelIt: 'CAP Socio', type: 'text', required: true },
    { name: 'partner_phone', label: 'Partner Phone', labelIt: 'Telefono Socio', type: 'tel', required: true },
    { name: 'partner_email', label: 'Partner Email', labelIt: 'Email Socio', type: 'email', required: true },
    { name: 'partner_equity_pct', label: 'Partner Ownership %', labelIt: 'Quota Socio %', type: 'number', required: true },
  ],
}

// ─── CLOSURE (LLC Dissolution) ────────────────────────────

export const CLOSURE_STEPS: WizardStep[] = [
  { id: 'contact', title: 'Contact Information', titleIt: 'Informazioni di Contatto', description: 'Your personal details', descriptionIt: 'I tuoi dati personali' },
  { id: 'company', title: 'Company Details', titleIt: 'Dettagli Società', description: 'The LLC to dissolve', descriptionIt: 'La LLC da chiudere' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload documents and review', descriptionIt: 'Carica documenti e rivedi' },
]

export const CLOSURE_FIELDS: Record<string, FieldConfig[]> = {
  contact: [
    { name: 'owner_first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true },
    { name: 'owner_last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true },
    { name: 'owner_email', label: 'Email', type: 'email', required: true },
    { name: 'owner_phone', label: 'Phone', labelIt: 'Telefono', type: 'tel', required: true },
  ],
  company: [
    { name: 'llc_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true },
    { name: 'llc_ein', label: 'EIN Number (optional)', labelIt: 'Numero EIN (opzionale)', type: 'text', required: false, format: 'ein' },
    { name: 'llc_state', label: 'State of Formation', labelIt: 'Stato di Costituzione', type: 'select', required: true, options: [
      { value: 'Wyoming', label: 'Wyoming' }, { value: 'Delaware', label: 'Delaware' },
      { value: 'Florida', label: 'Florida' }, { value: 'New Mexico', label: 'New Mexico' },
      { value: 'Texas', label: 'Texas' }, { value: 'California', label: 'California' },
      { value: 'New York', label: 'New York' }, { value: 'Nevada', label: 'Nevada' },
    ]},
    { name: 'llc_formation_year', label: 'Formation Year', labelIt: 'Anno di Costituzione', type: 'number', required: true },
    { name: 'registered_agent', label: 'Current Registered Agent (optional)', labelIt: 'Agente Registrato Attuale (opzionale)', type: 'text', required: false },
    { name: 'tax_returns_filed', label: 'Tax Returns Filed?', labelIt: 'Dichiarazioni Presentate?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
      { value: 'No', label: 'No' },
      { value: 'Not sure', label: 'Not sure', labelIt: 'Non sono sicuro' },
    ]},
    { name: 'tax_returns_years', label: 'Which years? (e.g. 2024, 2025)', labelIt: 'Quali anni? (es. 2024, 2025)', type: 'text', required: false },
  ],
  documents: [
    { name: 'articles_of_organization', label: 'Articles of Organization (optional)', labelIt: 'Atto Costitutivo (opzionale)', type: 'file', required: false },
    { name: 'ein_letter', label: 'EIN Letter (optional)', labelIt: 'Lettera EIN (opzionale)', type: 'file', required: false },
    { name: 'other_documents', label: 'Other Relevant Documents', labelIt: 'Altri Documenti Rilevanti', type: 'file', required: false },
    { name: 'disclaimer_accepted', label: 'I confirm that all information is accurate. I understand the closure fee does not include outstanding state taxes or fees.', labelIt: 'Confermo che le informazioni sono corrette. Comprendo che la tariffa di chiusura non include tasse o spese statali pendenti.', type: 'checkbox', required: true },
  ],
}

// ─── COMPANY INFO (standalone business Tax Return intake) ──

export const COMPANY_INFO_STEPS: WizardStep[] = [
  { id: 'company', title: 'Company Information', titleIt: 'Informazioni Società', description: 'Your existing LLC details', descriptionIt: 'Dettagli della tua LLC esistente' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload required documents', descriptionIt: 'Carica i documenti necessari' },
]

export const COMPANY_INFO_FIELDS: Record<string, FieldConfig[]> = {
  company: [
    { name: 'company_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true },
    { name: 'state_of_formation', label: 'State of Formation', labelIt: 'Stato di Costituzione', type: 'select', required: true, options: [
      { value: 'Alabama', label: 'Alabama' }, { value: 'Alaska', label: 'Alaska' },
      { value: 'Arizona', label: 'Arizona' }, { value: 'Arkansas', label: 'Arkansas' },
      { value: 'California', label: 'California' }, { value: 'Colorado', label: 'Colorado' },
      { value: 'Connecticut', label: 'Connecticut' }, { value: 'Delaware', label: 'Delaware' },
      { value: 'Florida', label: 'Florida' }, { value: 'Georgia', label: 'Georgia' },
      { value: 'Hawaii', label: 'Hawaii' }, { value: 'Idaho', label: 'Idaho' },
      { value: 'Illinois', label: 'Illinois' }, { value: 'Indiana', label: 'Indiana' },
      { value: 'Iowa', label: 'Iowa' }, { value: 'Kansas', label: 'Kansas' },
      { value: 'Kentucky', label: 'Kentucky' }, { value: 'Louisiana', label: 'Louisiana' },
      { value: 'Maine', label: 'Maine' }, { value: 'Maryland', label: 'Maryland' },
      { value: 'Massachusetts', label: 'Massachusetts' }, { value: 'Michigan', label: 'Michigan' },
      { value: 'Minnesota', label: 'Minnesota' }, { value: 'Mississippi', label: 'Mississippi' },
      { value: 'Missouri', label: 'Missouri' }, { value: 'Montana', label: 'Montana' },
      { value: 'Nebraska', label: 'Nebraska' }, { value: 'Nevada', label: 'Nevada' },
      { value: 'New Hampshire', label: 'New Hampshire' }, { value: 'New Jersey', label: 'New Jersey' },
      { value: 'New Mexico', label: 'New Mexico' }, { value: 'New York', label: 'New York' },
      { value: 'North Carolina', label: 'North Carolina' }, { value: 'North Dakota', label: 'North Dakota' },
      { value: 'Ohio', label: 'Ohio' }, { value: 'Oklahoma', label: 'Oklahoma' },
      { value: 'Oregon', label: 'Oregon' }, { value: 'Pennsylvania', label: 'Pennsylvania' },
      { value: 'Rhode Island', label: 'Rhode Island' }, { value: 'South Carolina', label: 'South Carolina' },
      { value: 'South Dakota', label: 'South Dakota' }, { value: 'Tennessee', label: 'Tennessee' },
      { value: 'Texas', label: 'Texas' }, { value: 'Utah', label: 'Utah' },
      { value: 'Vermont', label: 'Vermont' }, { value: 'Virginia', label: 'Virginia' },
      { value: 'Washington', label: 'Washington' }, { value: 'West Virginia', label: 'West Virginia' },
      { value: 'Wisconsin', label: 'Wisconsin' }, { value: 'Wyoming', label: 'Wyoming' },
    ]},
    { name: 'formation_date', label: 'Formation Date', labelIt: 'Data Costituzione', type: 'date', required: true },
    { name: 'ein', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein', hint: 'e.g. 30-1482516' },
    { name: 'business_purpose', label: 'Business Activities', labelIt: 'Attività Aziendali', type: 'textarea', required: true },
  ],
  documents: [
    { name: 'passport_owner', label: 'Passport Scan (Owner)', labelIt: 'Scansione Passaporto (Titolare)', type: 'file', required: true, hint: 'Clear photo of passport data page', hintIt: 'Foto chiara della pagina dati del passaporto' },
    { name: 'articles_of_organization', label: 'Articles of Organization', labelIt: 'Atto Costitutivo', type: 'file', required: true },
    { name: 'ein_letter', label: 'EIN Letter (CP 575)', labelIt: 'Lettera EIN (CP 575)', type: 'file', required: false },
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
  ],
}

/**
 * Get the correct steps and fields based on wizard type and entity type.
 */
export function getWizardConfig(wizardType: string, entityType?: string, bankingProvider?: string) {
  const isMMLLC = entityType === 'MMLLC'

  switch (wizardType) {
    case 'formation':
      return {
        steps: isMMLLC ? FORMATION_STEPS_MMLLC : FORMATION_STEPS,
        fields: FORMATION_FIELDS,
      }
    case 'onboarding':
      return {
        steps: isMMLLC ? ONBOARDING_STEPS_MMLLC : ONBOARDING_STEPS,
        fields: ONBOARDING_FIELDS,
      }
    case 'tax':
    case 'tax_return':
      if (entityType === 'MMLLC' || entityType === 'Multi-Member LLC') {
        return { steps: TAX_MMLLC_STEPS, fields: TAX_MMLLC_FIELDS }
      }
      if (entityType === 'Corp' || entityType === 'Corporation' || entityType === 'C-Corp') {
        return { steps: TAX_CORP_STEPS, fields: TAX_CORP_FIELDS }
      }
      return { steps: TAX_STEPS, fields: TAX_FIELDS }
    case 'itin':
      return {
        steps: ITIN_STEPS,
        fields: ITIN_FIELDS,
      }
    case 'banking':
    case 'banking_payset':
      if (bankingProvider === 'relay') {
        return {
          steps: BANKING_RELAY_STEPS,
          fields: BANKING_RELAY_FIELDS,
        }
      }
      return {
        steps: BANKING_PAYSET_STEPS,
        fields: BANKING_PAYSET_FIELDS,
      }
    case 'banking_relay':
      return {
        steps: BANKING_RELAY_STEPS,
        fields: BANKING_RELAY_FIELDS,
      }
    case 'company_info':
      return {
        steps: COMPANY_INFO_STEPS,
        fields: COMPANY_INFO_FIELDS,
      }
    case 'closure':
    case 'company_closure':
      return {
        steps: CLOSURE_STEPS,
        fields: CLOSURE_FIELDS,
      }
    default:
      return {
        steps: FORMATION_STEPS,
        fields: FORMATION_FIELDS,
      }
  }
}
