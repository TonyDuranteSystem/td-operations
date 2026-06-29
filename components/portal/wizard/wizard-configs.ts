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
// Supports both individual persons and company entities.
// Conditional fields use field-relative keys (evaluated per-member in wizard-client.tsx).

export const MEMBER_FIELDS: FieldConfig[] = [
  // ── Member type selector (always shown) ──
  { name: 'member_type', label: 'Member Type', labelIt: 'Tipo Membro', type: 'select', required: true, options: [
    { value: 'individual', label: 'Individual Person', labelIt: 'Persona Fisica' },
    { value: 'company', label: 'Company / Entity', labelIt: 'Società / Entità' },
  ]},

  // ── Individual person fields (shown when member_type = 'individual') ──
  { name: 'member_first_name', label: 'First Name', labelIt: 'Nome', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_last_name', label: 'Last Name', labelIt: 'Cognome', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_email', label: 'Email', type: 'email', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_dob', label: 'Date of Birth', labelIt: 'Data di Nascita', type: 'date', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_nationality', label: 'Nationality', labelIt: 'Nazionalità', type: 'country', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_street', label: 'Street Address', labelIt: 'Indirizzo', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_city', label: 'City', labelIt: 'Città', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_state_province', label: 'State/Province', labelIt: 'Stato/Provincia', type: 'text', required: false, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_zip', label: 'ZIP Code', labelIt: 'CAP', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true, conditional: { field: 'member_type', value: 'individual' } },
  // Passport per individual member — every member of a multi-member LLC must
  // provide ID. Owner's passport is collected on the Documents step; each
  // additional individual member uploads theirs here. The upload key resolves
  // to member_{idx}_member_passport (see wizard-client members repeater), which
  // formation materialization reads to file each member's passport privately.
  { name: 'member_passport', label: 'Passport Scan', labelIt: 'Scansione Passaporto', type: 'file', required: true, hint: 'Clear photo of the passport data page', hintIt: 'Foto chiara della pagina dati del passaporto', conditional: { field: 'member_type', value: 'individual' } },

  // ── Ownership % (always shown — applies to both types) ──
  { name: 'member_ownership_pct', label: 'Ownership %', labelIt: 'Quota %', type: 'number', required: true },

  // ── Company entity fields (shown when member_type = 'company') ──
  { name: 'member_company_name', label: 'Company Legal Name', labelIt: 'Ragione Sociale', type: 'text', required: true, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_ein', label: 'Company EIN (if US)', labelIt: 'EIN Società (se USA)', type: 'text', required: false, format: 'ein', conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_street', label: 'Company Street Address', labelIt: 'Indirizzo Società', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_city', label: 'Company City', labelIt: 'Città Società', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_state', label: 'Company State/Province', labelIt: 'Stato Società', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_zip', label: 'Company ZIP Code', labelIt: 'CAP Società', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_country', label: 'Company Country', labelIt: 'Paese Società', type: 'country', required: true, conditional: { field: 'member_type', value: 'company' } },
  // Representative — the person who acts on behalf of the company
  { name: 'member_rep_name', label: 'Representative Full Name', labelIt: 'Nome Rappresentante', type: 'text', required: true, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_email', label: 'Representative Email', labelIt: 'Email Rappresentante', type: 'email', required: true, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_phone', label: 'Representative Phone', labelIt: 'Telefono Rappresentante', type: 'tel', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_address_street', label: 'Representative Street Address', labelIt: 'Indirizzo Rappresentante', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_address_city', label: 'Representative City', labelIt: 'Città Rappresentante', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_address_state', label: 'Representative State/Province', labelIt: 'Stato Rappresentante', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_address_zip', label: 'Representative ZIP', labelIt: 'CAP Rappresentante', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_rep_address_country', label: 'Representative Country', labelIt: 'Paese Rappresentante', type: 'country', required: false, conditional: { field: 'member_type', value: 'company' } },
]

// ─── "Applies for ITIN?" per-person fields (dev_task fcf5e254) ──
// Injected by wizard-client ONLY when the offer bundled a start-at-wizard ITIN
// purchase (itinCount > 0). The offer dictates HOW MANY ITINs were bought; the
// client marks WHO applies. Required so the choice is explicit; wizard-client
// also enforces that the number of "Yes" answers equals the purchased quantity.
export const OWNER_ITIN_FIELD: FieldConfig = {
  name: 'owner_needs_itin',
  label: 'Apply for an ITIN for this person?',
  labelIt: 'Richiedere un ITIN per questa persona?',
  type: 'select',
  required: true,
  options: [
    { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    { value: 'No', label: 'No', labelIt: 'No' },
  ],
  hint: 'Your offer includes ITIN application(s).',
  hintIt: 'La tua offerta include la richiesta ITIN.',
}

export const MEMBER_ITIN_FIELD: FieldConfig = {
  name: 'member_needs_itin',
  label: 'Apply for an ITIN for this member?',
  labelIt: 'Richiedere un ITIN per questo membro?',
  type: 'select',
  required: true,
  options: [
    { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    { value: 'No', label: 'No', labelIt: 'No' },
  ],
  // Individual members only — company members do not get a personal ITIN.
  conditional: { field: 'member_type', value: 'individual' },
}

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
  { name: 'owner_street', label: 'Personal Home Address — where you physically live', labelIt: 'Indirizzo di Residenza Personale — dove vivi fisicamente', type: 'text', required: true, hint: 'Enter the address of the home where you actually live right now. This is your PERSONAL address, NOT your company\'s address — and NOT necessarily your country of citizenship. Example: if you are an Italian citizen but you currently live in Dubai or Portugal, enter your Dubai or Portugal address.', hintIt: 'Inserisci l\'indirizzo della casa in cui vivi effettivamente in questo momento. È il tuo indirizzo PERSONALE, NON quello della società — e NON necessariamente il tuo paese di cittadinanza. Esempio: se sei cittadino italiano ma vivi a Dubai o in Portogallo, inserisci l\'indirizzo di Dubai o del Portogallo.' },
  { name: 'owner_city', label: 'City (where you live)', labelIt: 'Città (dove vivi)', type: 'text', required: true },
  { name: 'owner_state_province', label: 'State/Province (where you live)', labelIt: 'Stato/Provincia (dove vivi)', type: 'text', required: true },
  { name: 'owner_zip', label: 'ZIP/Postal Code (where you live)', labelIt: 'CAP (dove vivi)', type: 'text', required: true },
  { name: 'owner_country', label: 'Country (where you physically live)', labelIt: 'Paese (dove vivi fisicamente)', type: 'country', required: true, hint: 'The country where you physically live right now — not your country of citizenship.', hintIt: 'Il paese in cui vivi fisicamente in questo momento — non la cittadinanza.' },
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

// SMLLC company fields — its OWN array (not TAX_COMPANY_BASE) so the clarity
// tweaks below apply ONLY to the SMLLC wizard, not MMLLC/Corp:
//  • improved principal_product_service hint
//  • US-activities split into a yes/no gate + conditional detail textarea
const TAX_SMLLC_COMPANY: FieldConfig[] = [
  { name: 'llc_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true },
  { name: 'ein_number', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein' },
  { name: 'date_of_incorporation', label: 'Date of Incorporation', labelIt: 'Data Costituzione', type: 'date', required: true },
  { name: 'state_of_incorporation', label: 'State of Incorporation', labelIt: 'Stato Costituzione', type: 'text', required: true },
  { name: 'principal_product_service', label: 'Principal Product/Service', labelIt: 'Prodotto/Servizio Principale', type: 'textarea', required: true, hint: 'Describe what your LLC actually does. Be specific — for example: "Online sale of digital courses about personal finance" is better than "Consulting." The more specific, the better for your tax filing.', hintIt: 'Descrivi cosa fa effettivamente la tua LLC. Sii specifico — per esempio: "Vendita online di corsi digitali sulla finanza personale" è meglio di "Consulenza." Più sei specifico, meglio è per la tua dichiarazione.' },
  { name: 'has_us_business_activities', label: 'Did your LLC conduct any business activities physically inside the United States during the year?', labelIt: 'La tua LLC ha svolto attività commerciali fisicamente negli Stati Uniti durante l\'anno?', type: 'select', required: true, options: [
    { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    { value: 'No', label: 'No', labelIt: 'No' },
  ], hint: 'This means physical offices, employees, inventory, or equipment located in the US. Online sales to US customers from outside the US does NOT count as US business activity.', hintIt: 'Questo significa uffici fisici, dipendenti, inventario o attrezzature negli USA. Le vendite online a clienti USA dall\'estero NON contano come attività commerciale USA.' },
  { name: 'us_business_activities_detail', label: 'Describe the US activities', labelIt: 'Descrivi le attività negli USA', type: 'textarea', required: true, conditional: { field: 'has_us_business_activities', value: 'Yes' }, hint: 'Describe what your LLC does inside the US and where.', hintIt: 'Descrivi cosa fa la tua LLC negli USA e dove.' },
  { name: 'website_url', label: 'Website (optional)', labelIt: 'Sito Web (opzionale)', type: 'text', required: false },
]

// Shared document fields for MMLLC / Corp.
// CSV-ONLY per-bank sections (master plan: sysdoc tax-financials-self-service-
// master-plan §2-3). Bank name is FREE TEXT — never a list, never a gate. The
// CSV requirement is framed as a service/gift: it is what lets us prepare the
// client's P&L + Balance Sheet accurately at no extra cost. Old in-flight
// drafts may still carry the legacy single `bank_statements` field — readers
// (collectUploadPaths, tax-form-setup) accept both shapes.
const TAX_DOCUMENTS_BASE: FieldConfig[] = [
  {
    name: 'bank_accounts',
    label: 'Your bank accounts — upload the CSV export (or PDF statement) for the entire year',
    labelIt: 'I tuoi conti bancari — carica l\'export CSV (o l\'estratto conto PDF) dell\'intero anno',
    type: 'repeater',
    repeaterRequired: true,
    hint: 'Upload your CSV export OR the official PDF statement, for the ENTIRE year (January 1 – December 31), not a piece of it. This lets us prepare your Profit & Loss and Balance Sheet for you — accurately and at no extra cost. Every bank lets you export it: in your online banking, open the account, choose Export/Download, set the dates to the full year, and pick CSV (or download the PDF statements). Add one section per bank account. Important: upload each file exactly as the bank gives it to you — do NOT merge, combine, or edit the files (tools like merge-csv.com change the format and make them unreadable).',
    hintIt: 'Carica il tuo export CSV OPPURE l\'estratto conto PDF ufficiale, per l\'INTERO anno (1 gennaio – 31 dicembre), non una parte. Questo ci permette di preparare per te il Conto Economico e lo Stato Patrimoniale — con precisione e senza costi aggiuntivi. Ogni banca permette di esportarlo: nell\'online banking, apri il conto, scegli Esporta/Scarica, imposta le date sull\'anno intero e seleziona CSV (oppure scarica gli estratti conto PDF). Aggiungi una sezione per ogni conto bancario. Importante: carica ogni file esattamente come te lo fornisce la banca — NON unire, combinare o modificare i file (strumenti come merge-csv.com cambiano il formato e li rendono illeggibili).',
    repeaterAddLabel: 'Add a bank account',
    repeaterAddLabelIt: 'Aggiungi un conto bancario',
    repeaterFields: [
      { name: 'bank_name', label: 'Bank name', labelIt: 'Nome della banca', type: 'text', required: true, placeholder: 'e.g. Mercury, Wise, Chase…', placeholderIt: 'es. Mercury, Wise, Chase…', hint: 'Type the bank\'s name — for the most common banks (Mercury, Relay, Wise, Revolut, Slash, Airwallex, Chase, PayPal) the exact step-by-step instructions to download the CSV will appear right below, as soon as you type it.', hintIt: 'Scrivi il nome della banca — per le banche più comuni (Mercury, Relay, Wise, Revolut, Slash, Airwallex, Chase, PayPal) le istruzioni passo-passo per scaricare il CSV appariranno qui sotto, appena lo scrivi.' },
      { name: 'account_label', label: 'Account nickname / last 4 digits (if you have more than one account at this bank)', labelIt: 'Nome conto / ultime 4 cifre (se hai più conti nella stessa banca)', type: 'text', required: false },
      { name: 'account_kind', label: 'Account type', labelIt: 'Tipo di conto', type: 'select', required: true, options: [
        { value: 'checking', label: 'Bank account (checking)', labelIt: 'Conto corrente' },
        { value: 'credit_card', label: 'Credit card', labelIt: 'Carta di credito' },
      ] },
      { name: 'statements', label: 'CSV export — entire year (PDF accepted but not recommended)', labelIt: 'Export CSV — anno intero (PDF accettato ma sconsigliato)', type: 'file', required: true, accept: '.csv,.pdf,text/csv,application/pdf',
        danger: {
          text: 'Uploading PDFs is NOT recommended. Any CPA or system takes hours to extract the data from a PDF, and transactions can be lost. We strongly recommend uploading CSV files only — it\'s easier and safer for everyone, and ALL banks let you download CSV. Don\'t rush this step: it\'s your Profit & Loss and Balance Sheet, an important step for your LLC.',
          textIt: 'Caricare PDF NON è consigliato. Qualsiasi commercialista o sistema impiega ore per estrarre i dati da un PDF, e alcune transazioni possono andare perse. Consigliamo vivamente di caricare solo file CSV — è più facile e sicuro per tutti, e TUTTE le banche permettono di scaricare i CSV. Non avere fretta in questo passaggio: è il tuo Conto Economico e Stato Patrimoniale, un passaggio importante per la tua LLC.',
        },
        hint: 'CSV export for the entire year, not a piece of it.', hintIt: 'Export CSV per l\'intero anno, non una parte.' },
    ],
  },
  // "Financial Statements (optional)" upload REMOVED (2026-06-17, Antonio): it sat
  // beside the per-bank CSV repeater and confused clients (Luca dropped Relay's 12
  // CSVs here instead of into the bank's own box during the Dynamiq MMLLC test). The
  // P&L/Balance-Sheet engine ONLY reads the per-bank `bank_accounts_*_statements`
  // files — this field was never ingested by anything (verified: zero downstream
  // readers). TAX_DOCUMENTS_BASE backs the MMLLC config and the Corp config
  // (TAX_CORP_FIELDS). Real entity types in the data: Single Member LLC,
  // Multi Member LLC, C-Corp Elected (no S-Corp). In practice this removal
  // affects the multi-member wizard — C-Corp Elected does not normalize to a
  // Corp routing value today, so it currently falls through to the SMLLC steps.
  // ── Prior-year return decision matrix (master plan §5). We need last year's
  // balance sheet to start this year's books from the right numbers.
  { name: 'prior_return_case', label: 'Last year\'s tax return', labelIt: 'Dichiarazione dei redditi dell\'anno scorso', type: 'select', required: true,
    hint: 'We use last year\'s return to start this year\'s books from the right numbers. Pick the situation that applies — if Tony Durante filed it for you, there is nothing to upload.',
    hintIt: 'Usiamo la dichiarazione dell\'anno scorso per partire dai numeri giusti. Scegli la situazione che si applica — se l\'ha presentata Tony Durante per te, non c\'è nulla da caricare.',
    options: [
      { value: 'we_filed', label: 'Tony Durante filed it for us', labelIt: 'L\'ha presentata Tony Durante per noi' },
      { value: 'filed_elsewhere', label: 'It was filed by another accountant', labelIt: 'L\'ha presentata un altro commercialista' },
      { value: 'first_year', label: 'This is our first year — the company was formed this tax year', labelIt: 'È il nostro primo anno — la società è stata costituita quest\'anno fiscale' },
      { value: 'never_filed', label: 'The company existed before, but no return was ever filed', labelIt: 'La società esisteva già, ma non è mai stata presentata una dichiarazione' },
    ] },
  { name: 'prior_year_return', label: 'Last year\'s filed tax return (PDF)', labelIt: 'Dichiarazione presentata l\'anno scorso (PDF)', type: 'file', required: true, accept: '.pdf,application/pdf',
    conditional: { field: 'prior_return_case', value: 'filed_elsewhere' },
    hint: 'Please upload the COMPLETE filed return as a PDF — all pages, including Schedule L (the balance sheet) and every K-1. A partial copy means we cannot verify your beginning balances and we will have to come back to you.',
    hintIt: 'Carica la dichiarazione COMPLETA in PDF — tutte le pagine, inclusi lo Schedule L (stato patrimoniale) e tutti i K-1. Una copia parziale non ci permette di verificare i saldi iniziali e dovremo ricontattarti.' },
  { name: 'prior_cleanup_interest', label: 'Would you like us to fix this with a back-filing?', labelIt: 'Vuoi che sistemiamo la situazione con una dichiarazione tardiva?', type: 'select', required: true,
    conditional: { field: 'prior_return_case', value: 'never_filed' },
    hint: 'A missing prior-year return can be filed late ("back-filing") to clean up the company\'s position with the IRS. If you are interested, we will prepare a quote — no commitment yet.',
    hintIt: 'Una dichiarazione mancante può essere presentata in ritardo ("back-filing") per regolarizzare la posizione con l\'IRS. Se ti interessa, prepariamo un preventivo — nessun impegno per ora.',
    options: [
      { value: 'Yes', label: 'Yes — send me a quote for the back-filing', labelIt: 'Sì — inviatemi un preventivo per il back-filing' },
      { value: 'No', label: 'No — continue with this year only', labelIt: 'No — proseguite solo con quest\'anno' },
    ] },
  { name: 'prior_never_filed_declaration', label: 'I declare, under my own responsibility, that no federal tax return was ever filed for this company for prior years, and I ask Tony Durante LLC to prepare this year\'s return without prior-year records.', labelIt: 'Dichiaro, sotto la mia responsabilità, che per questa società non è mai stata presentata alcuna dichiarazione federale per gli anni precedenti, e chiedo a Tony Durante LLC di preparare la dichiarazione di quest\'anno senza i dati degli anni precedenti.', type: 'checkbox', required: true,
    conditional: { field: 'prior_cleanup_interest', value: 'No' } },
  { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
]

// ─── TAX SMLLC documents (all optional — different from MMLLC/Corp) ──

const TAX_SMLLC_DOCUMENTS: FieldConfig[] = [
  // "Bank Statements" + "Financial Statements" uploads REMOVED (2026-06-17, Antonio):
  // a single-member LLC enters its figures as numbers in the "Financial Information"
  // step above — neither upload was needed, both were optional, never ingested by
  // anything, and only added confusion. Prior-year return is KEPT (last year's filed
  // 5472/1120 starts this year's books from the right numbers).
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
    // SMLLC beneficial-owner questions removed (2026-06-11): a single-member LLC
    // is always one person with no holding company above it, so the 100%-direct
    // and ultimate-owner fields only caused confusion — 8 clients entered
    // themselves as the "ultimate owner". The 5472 still treats the sole member
    // as the reporting/related party; no extra ownership input is needed here.
  ],
  company: TAX_SMLLC_COMPANY,
  financials: [
    { name: 'formation_costs', label: 'Formation Costs ($)', labelIt: 'Costi di Costituzione ($)', type: 'number', required: true, hint: 'Total amount paid to form the LLC: state filing fees, registered agent fees, attorney/service fees. Enter 0 if already deducted in a prior year. If your LLC was formed before the tax year (e.g., formed in 2023 for a 2025 return), enter 0. Only enter costs if you formed the LLC during this tax year.', hintIt: 'Importo totale pagato per costituire la LLC: tasse statali, agente registrato, avvocato/servizio. Inserisci 0 se già dedotto in un anno precedente. Se la tua LLC è stata costituita prima dell\'anno fiscale (es. costituita nel 2023 per una dichiarazione 2025), inserisci 0. Inserisci i costi solo se hai costituito la LLC durante questo anno fiscale.' },
    { name: 'bank_contributions', label: 'Bank Contributions ($)', labelIt: 'Conferimenti Bancari ($)', type: 'number', required: true, hint: 'Total money you personally deposited or wired INTO the LLC bank account during the year (capital contributions, not revenue). For example: if you transferred $5,000 from your personal bank account to your LLC\'s Mercury or Relay account, enter 5000.', hintIt: 'Denaro totale che hai depositato o trasferito SUL conto bancario della LLC durante l\'anno (conferimenti di capitale, non ricavi). Per esempio: se hai trasferito $5.000 dal tuo conto bancario personale al conto Mercury o Relay della tua LLC, inserisci 5000.' },
    { name: 'distributions_withdrawals', label: 'Distributions / Withdrawals ($)', labelIt: 'Distribuzioni / Prelievi ($)', type: 'number', required: true, hint: 'Total money you took OUT of the LLC bank account for personal use during the year. For example: if you transferred $3,000 from your LLC\'s account to your personal account, enter 3000.', hintIt: 'Denaro totale che hai prelevato dal conto bancario della LLC per uso personale durante l\'anno. Per esempio: se hai trasferito $3.000 dal conto della tua LLC al tuo conto personale, inserisci 3000.' },
    { name: 'personal_expenses', label: 'Personal Expenses Paid by LLC ($)', labelIt: 'Spese Personali Pagate dalla LLC ($)', type: 'number', required: true, hint: 'Total personal (non-business) expenses paid from the LLC account. Examples: personal travel, personal subscriptions, gifts. Enter 0 if none.', hintIt: 'Spese personali (non aziendali) pagate dal conto della LLC. Esempi: viaggi personali, abbonamenti personali, regali. Inserisci 0 se nessuna.' },
    { name: 'has_related_party_transactions', label: 'Did your LLC have any transactions with other companies that you own, that your family members own, or that own your LLC?', labelIt: 'La tua LLC ha avuto transazioni con altre società di tua proprietà, di proprietà di familiari, o che possiedono la tua LLC?', type: 'select', required: true, options: [
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
      { value: 'No', label: 'No', labelIt: 'No' },
    ], hint: 'This is one of the most important questions for your tax filing. "Related party" means ANY company connected to you or your family — including companies you own in other countries, companies that paid your LLC, or companies your LLC paid. If your LLC received money from or sent money to ANY company connected to you, the answer is YES.', hintIt: 'Questa è una delle domande più importanti per la tua dichiarazione. "Parte correlata" significa QUALSIASI società collegata a te o alla tua famiglia — incluse società che possiedi in altri paesi, società che hanno pagato la tua LLC, o società a cui la tua LLC ha pagato. Se la tua LLC ha ricevuto o inviato denaro a QUALSIASI società collegata a te, la risposta è SÌ.', warningOnValue: { value: 'No', text: 'You are declaring that your LLC had NO transactions with any company owned by you, your family members, or any entity connected to you. If this is incorrect, the IRS may apply a $25,000 penalty. Please review carefully before proceeding.', textIt: 'Stai dichiarando che la tua LLC NON ha avuto transazioni con nessuna società di tua proprietà, dei tuoi familiari, o collegata a te. Se questo non è corretto, l\'IRS può applicare una sanzione di $25.000. Verifica attentamente prima di procedere.' } },
    {
      name: 'related_party_transactions',
      label: 'Related Party Transactions',
      labelIt: 'Transazioni con Parti Correlate',
      type: 'repeater',
      // Required because this only appears after the client answered "Yes" to the
      // gate above — at that point at least one transaction MUST be listed
      // (validated in wizard-client validateStep). Hidden when the gate is "No".
      required: true,
      conditional: { field: 'has_related_party_transactions', value: 'Yes' },
      hint: 'Since you answered "Yes", list every transaction between your LLC and a related party (any company connected to you, your family, or your LLC). Add one entry per party — at least one is required, and all fields in each entry must be completed.',
      hintIt: 'Poiché hai risposto "Sì", elenca ogni transazione tra la tua LLC e una parte correlata (qualsiasi società collegata a te, alla tua famiglia o alla tua LLC). Aggiungi una voce per ciascuna parte — almeno una è obbligatoria e tutti i campi di ogni voce devono essere compilati.',
      repeaterFields: [
        { name: 'rpt_company_name', label: 'Company / Person Name', labelIt: 'Nome Società / Persona', type: 'text', required: true, hint: 'Legal name of the related foreign company or person.', hintIt: 'Nome legale della società o persona straniera correlata.' },
        { name: 'rpt_address', label: 'Party Address', labelIt: 'Indirizzo della Parte', type: 'text', required: true, hint: 'Full address including city, country (e.g., "30 N Gould St, Sheridan, WY 82801, USA")', hintIt: 'Indirizzo completo con città e paese' },
        { name: 'rpt_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
        { name: 'rpt_vat_number', label: 'Foreign Tax ID / VAT of this party', labelIt: 'Codice Fiscale / P.IVA Estero della parte', type: 'text', required: true, hint: 'Required by the IRS on Form 5472. Enter this party\'s tax identification number in its own country (VAT number, Codice Fiscale, NIF, EIN, etc.). If this party genuinely has no tax ID, type "None".', hintIt: 'Richiesto dall\'IRS nel Modulo 5472. Inserisci il numero di identificazione fiscale di questa parte nel suo paese (P.IVA, Codice Fiscale, NIF, EIN, ecc.). Se questa parte non ha alcun codice fiscale, scrivi "None".' },
        { name: 'rpt_amount', label: 'Transaction Amount ($)', labelIt: 'Importo Transazione ($)', type: 'number', required: true, hint: 'Total USD value of transactions with this party for the year. Use the exchange rate at the time of the transaction.', hintIt: 'Valore totale in USD delle transazioni con questa parte per l\'anno.' },
        { name: 'rpt_direction', label: 'Transaction Direction', labelIt: 'Direzione della Transazione', type: 'select', required: true, options: [
          { value: 'to_llc', label: 'Money FROM this party TO your LLC', labelIt: 'Denaro DA questa parte ALLA tua LLC' },
          { value: 'from_llc', label: 'Money FROM your LLC TO this party', labelIt: 'Denaro DALLA tua LLC A questa parte' },
        ], hint: 'Did your LLC receive the money, or pay the money?', hintIt: 'La tua LLC ha ricevuto il denaro, o lo ha pagato?' },
        { name: 'rpt_type', label: 'Type of Transaction', labelIt: 'Tipo di Transazione', type: 'select', required: true, options: [
          { value: 'sale_goods', label: 'Sale of goods / products', labelIt: 'Vendita di beni / prodotti' },
          { value: 'services', label: 'Services or consulting fee', labelIt: 'Servizi o consulenza' },
          { value: 'rent', label: 'Rent (property / equipment)', labelIt: 'Affitto (immobili / attrezzature)' },
          { value: 'royalties', label: 'Royalties or license fees', labelIt: 'Royalty o licenze' },
          { value: 'interest', label: 'Interest', labelIt: 'Interessi' },
          { value: 'loan', label: 'Loan (money lent or borrowed)', labelIt: 'Prestito (denaro prestato o ricevuto)' },
          { value: 'capital', label: 'Capital contribution / distribution', labelIt: 'Conferimento di capitale / distribuzione' },
          { value: 'management_fee', label: 'Management or commission fee', labelIt: 'Compenso di gestione o commissione' },
          { value: 'reimbursement', label: 'Reimbursement of expenses', labelIt: 'Rimborso spese' },
          { value: 'other', label: 'Other', labelIt: 'Altro' },
        ], hint: 'What kind of transaction was it? The IRS requires each related-party transaction to be reported by type on Form 5472 — pick the closest match (use the Description below for details). If unsure, choose "Other" and explain below.', hintIt: 'Di che tipo di transazione si tratta? L\'IRS richiede che ogni transazione con parti correlate sia riportata per tipo nel Modulo 5472 — scegli la voce più simile (usa la Descrizione qui sotto per i dettagli). Se non sei sicuro, scegli "Altro" e spiega sotto.' },
        { name: 'rpt_description', label: 'Description', labelIt: 'Descrizione', type: 'textarea', required: true, hint: 'Describe the nature of the transaction (e.g., "Service fee paid for consulting", "Loan from parent company", "Royalty payment").', hintIt: 'Descrivi la natura della transazione (es. "Commissione di servizio per consulenza", "Prestito dalla società madre").' },
      ],
      repeaterAddLabel: 'Add related party transaction',
      repeaterAddLabelIt: 'Aggiungi transazione con parte correlata',
    },
    { name: 'smllc_additional_comments', label: 'Additional Comments', labelIt: 'Commenti Aggiuntivi', type: 'textarea', required: false, hint: 'Any other financial details, unusual transactions, or information you think is relevant for your tax return.', hintIt: 'Qualsiasi altro dettaglio finanziario, transazione insolita o informazione che ritieni rilevante per la tua dichiarazione.' },
  ],
  documents: TAX_SMLLC_DOCUMENTS,
}

// ─── TAX MMLLC / Partnership (Form 1065) ──────────────────

// ── MMLLC member fields (tax intake — §14 form redesign, approved 2026-06-12).
// Rendered by the wizard's members machinery (step id 'members', keys flatten
// to member_{idx}_{name}). Every K-1 the IRS receives needs this data; a wrong
// or missing partner statement costs $340 each, an incomplete return $255 per
// partner per month. Pre-filled from CRM where we already know the member —
// the client CONFIRMS rather than types.
export const TAX_MEMBER_FIELDS: FieldConfig[] = [
  { name: 'member_type', label: 'Is this member a person or a company?', labelIt: 'Questo socio è una persona o una società?', type: 'select', required: true, options: [
    { value: 'individual', label: 'A person', labelIt: 'Una persona' },
    { value: 'company', label: 'A company / entity', labelIt: 'Una società / entità' },
  ], hint: 'Most LLC members are people. Choose "a company" only if the owner listed in the Operating Agreement is itself a company.', hintIt: 'La maggior parte dei soci sono persone. Scegli "una società" solo se il socio indicato nell\'Operating Agreement è a sua volta una società.' },
  // ── Person ──
  { name: 'member_first_name', label: 'First name (as in the passport)', labelIt: 'Nome (come sul passaporto)', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' }, hint: 'Exactly as written in the passport — the IRS matches names letter by letter.', hintIt: 'Esattamente come scritto sul passaporto — l\'IRS confronta i nomi lettera per lettera.' },
  { name: 'member_last_name', label: 'Last name (as in the passport)', labelIt: 'Cognome (come sul passaporto)', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_citizenship', label: 'Country of citizenship', labelIt: 'Paese di cittadinanza', type: 'country', required: true, conditional: { field: 'member_type', value: 'individual' }, hint: 'The country of the passport. This tells the IRS the member is a foreign (non-US) partner.', hintIt: 'Il paese del passaporto. Indica all\'IRS che il socio è straniero (non USA).' },
  { name: 'member_residence_country', label: 'Country where this member lives', labelIt: 'Paese dove vive questo socio', type: 'country', required: true, conditional: { field: 'member_type', value: 'individual' }, hint: 'Where the member physically lives today — not necessarily the citizenship. Example: Italian citizen living in Dubai → Dubai (UAE).', hintIt: 'Dove vive fisicamente oggi — non necessariamente la cittadinanza. Esempio: cittadino italiano che vive a Dubai → Emirati Arabi.' },
  { name: 'member_street', label: 'Home address (street)', labelIt: 'Indirizzo di casa (via)', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' }, hint: 'The member\'s personal home address. This address goes on the member\'s IRS statement (Schedule K-1) — it must be real and current.', hintIt: 'L\'indirizzo di casa personale del socio. Va sul documento IRS del socio (Schedule K-1) — deve essere reale e attuale.' },
  { name: 'member_city', label: 'City', labelIt: 'Città', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  { name: 'member_zip', label: 'ZIP / Postal code', labelIt: 'CAP', type: 'text', required: true, conditional: { field: 'member_type', value: 'individual' } },
  // ── Company ──
  { name: 'member_company_name', label: 'Company legal name', labelIt: 'Ragione sociale', type: 'text', required: true, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_ein', label: 'Company EIN or foreign tax number (if any)', labelIt: 'EIN o codice fiscale estero della società (se esiste)', type: 'text', required: false, conditional: { field: 'member_type', value: 'company' } },
  { name: 'member_company_owner', label: 'Who owns this company? (name of the real person behind it)', labelIt: 'Chi possiede questa società? (nome della persona reale dietro di essa)', type: 'text', required: true, conditional: { field: 'member_type', value: 'company' }, hint: 'When a member is a company, the IRS wants to know the real person at the top. Write their full name.', hintIt: 'Quando un socio è una società, l\'IRS vuole sapere chi è la persona reale al vertice. Scrivi il nome completo.' },
  // ── ITIN (both types — for a company member it's the beneficial owner's) ──
  { name: 'member_itin_status', label: 'Does this member have a US tax number (ITIN)?', labelIt: 'Questo socio ha un numero fiscale USA (ITIN)?', type: 'select', required: true, options: [
    { value: 'has_itin', label: 'Yes — I will enter it below', labelIt: 'Sì — lo inserisco qui sotto' },
    { value: 'applied', label: 'Applied for — still waiting', labelIt: 'Richiesto — in attesa' },
    { value: 'none', label: 'No — never applied', labelIt: 'No — mai richiesto' },
  ], hint: 'The ITIN is the US tax ID for foreigners. The return CAN be filed while an ITIN is pending ("applied for") — but every member should have one. If a member has never applied, we can take care of the ITIN application for you — just continue, and we will contact you about it.', hintIt: 'L\'ITIN è il codice fiscale USA per stranieri. La dichiarazione PUÒ essere presentata anche con ITIN in attesa ("richiesto") — ma ogni socio dovrebbe averne uno. Se un socio non l\'ha mai richiesto, possiamo occuparci noi della pratica ITIN — prosegui pure, ti contatteremo.' },
  { name: 'member_itin', label: 'ITIN number', labelIt: 'Numero ITIN', type: 'text', required: true, conditional: { field: 'member_itin_status', value: 'has_itin' }, hint: 'Format: 9XX-XX-XXXX. You find it on the IRS letter (CP565).', hintIt: 'Formato: 9XX-XX-XXXX. Lo trovi sulla lettera IRS (CP565).' },
  // ── Ownership ──
  { name: 'member_ownership_pct', label: 'Ownership % at the end of the year', labelIt: 'Quota % a fine anno', type: 'number', required: true, hint: 'The percentage of the company this member owns, as written in the Operating Agreement. All members together must total 100%.', hintIt: 'La percentuale della società posseduta da questo socio, come da Operating Agreement. Tutti i soci insieme devono fare 100%.' },
  { name: 'member_foreign_tax_id', label: 'Home-country tax ID (Codice Fiscale, NIF, Steuernummer…)', labelIt: 'Codice fiscale del paese di residenza', type: 'text', required: false, hint: 'The member\'s personal tax number in their own country. It goes on the W-8BEN form — if you don\'t know it now, you can skip it.', hintIt: 'Il codice fiscale personale del socio nel suo paese. Va sul modulo W-8BEN — se non lo sai ora, puoi saltarlo.' },
  { name: 'member_w8ben', label: 'Form W-8BEN (optional — upload if you have it)', labelIt: 'Modulo W-8BEN (facoltativo — caricalo se ce l\'hai)', type: 'file', required: false, hint: 'The W-8BEN certifies the member is foreign. If you don\'t have it, skip — we will handle it.', hintIt: 'Il W-8BEN certifica che il socio è straniero. Se non ce l\'hai, salta — ci pensiamo noi.' },
]

export const TAX_MMLLC_STEPS: WizardStep[] = [
  // No separate "Your Information" step (Antonio, 2026-06-12): the person
  // filling the form IS one of the members — their card is pre-filled from
  // the CRM in the members step. Email/phone are already on file (portal
  // login + contact record); the home-country tax ID moved to the member card.
  { id: 'members', title: 'Members & Ownership', titleIt: 'Soci e Quote', description: 'Every member of the LLC, including you — check what we have on file', descriptionIt: 'Tutti i soci della LLC, incluso te — controlla i dati che abbiamo' },
  { id: 'company', title: 'Company', titleIt: 'Società', description: 'Your LLC details', descriptionIt: 'Dettagli della tua LLC' },
  { id: 'us_activity', title: 'Activity in the US', titleIt: 'Attività negli USA', description: 'Five questions about physical US presence', descriptionIt: 'Cinque domande sulla presenza fisica negli USA' },
  { id: 'compliance', title: 'A Few Yes/No Questions', titleIt: 'Alcune Domande Sì/No', description: 'Most clients answer No to everything here', descriptionIt: 'La maggior parte dei clienti risponde No a tutte' },
  { id: 'documents', title: 'Bank Statements & Documents', titleIt: 'Estratti Conto e Documenti', description: 'Upload statements and review', descriptionIt: 'Carica estratti conto e rivedi' },
]

// Yes/No options shared by the redesign's explicit selects (NEVER ambiguous
// optional checkboxes — an unchecked box can't be told apart from a skipped one).
const YN: { value: string; label: string; labelIt?: string }[] = [
  { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
  { value: 'No', label: 'No' },
]

export const TAX_MMLLC_FIELDS: Record<string, FieldConfig[]> = {
  // Members machinery (wizard-client renders TAX_MEMBER_FIELDS per member,
  // pre-filled from CRM — the client confirms instead of typing). Step-level
  // questions below the member cards:
  members: [
    ...TAX_MEMBER_FIELDS,
  ],

  company: [
    { name: 'llc_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true, hint: 'The exact name on your Articles of Organization, including "LLC".', hintIt: 'Il nome esatto sull\'Atto Costitutivo, inclusa la sigla "LLC".' },
    { name: 'ein_number', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein', hint: 'The company\'s 9-digit tax number, on the IRS letter CP575 (format 12-3456789).', hintIt: 'Il numero fiscale a 9 cifre della società, sulla lettera IRS CP575 (formato 12-3456789).' },
    { name: 'date_of_incorporation', label: 'Date of Incorporation', labelIt: 'Data Costituzione', type: 'date', required: true, hint: 'The date the LLC was officially formed — on the Articles of Organization.', hintIt: 'La data di costituzione ufficiale della LLC — sull\'Atto Costitutivo.' },
    { name: 'state_of_incorporation', label: 'State of Incorporation', labelIt: 'Stato di Costituzione', type: 'text', required: true, hint: 'The US state where the LLC is registered (e.g. New Mexico, Wyoming, Florida, Delaware).', hintIt: 'Lo stato USA dove la LLC è registrata (es. New Mexico, Wyoming, Florida, Delaware).' },
    { name: 'principal_product_service', label: 'What does the company actually do?', labelIt: 'Cosa fa effettivamente la società?', type: 'textarea', required: true, hint: 'Be specific — "online sale of silver jewelry through Shopify" is better than "e-commerce". The more specific, the better your filing. We use this to choose the official IRS business code for you.', hintIt: 'Sii specifico — "vendita online di gioielli in argento tramite Shopify" è meglio di "e-commerce". Più sei specifico, migliore sarà la dichiarazione. Lo usiamo per scegliere noi il codice attività IRS.' },
    { name: 'website_url', label: 'Website (optional)', labelIt: 'Sito Web (facoltativo)', type: 'text', required: false },
  ],

  // The facts that determine US tax exposure. The client never self-certifies
  // "effectively connected income" — we ask what actually happened and OUR
  // accountant draws the legal conclusion (§14 redesign; the old form asked
  // the client to make this call, which clients cannot do).
  us_activity: [
    { name: 'us_office_warehouse', label: 'Beyond the company\'s US business address, does the company have a REAL place in the US — an office you rent, a warehouse, a shop?', labelIt: 'Oltre all\'indirizzo aziendale USA, la società ha un luogo REALE negli USA — un ufficio in affitto, un magazzino, un negozio?', type: 'select', required: true, options: YN, hint: 'Your company\'s US business address — the one on your documents, provided through us (registered agent / virtual mailbox) — does NOT count and is NOT what we are asking about. We are asking about a real, physical place: an office someone works in, a warehouse with your goods, a shop. Almost all our clients answer No.', hintIt: 'L\'indirizzo aziendale USA della tua società — quello sui documenti, fornito tramite noi (registered agent / casella virtuale) — NON conta e NON è ciò che chiediamo. Chiediamo di un luogo fisico reale: un ufficio dove qualcuno lavora, un magazzino con la tua merce, un negozio. Quasi tutti i nostri clienti rispondono No.' },
    { name: 'us_people_working', label: 'Does anyone work for the company physically inside the US (employees, agents, contractors)?', labelIt: 'Qualcuno lavora per la società fisicamente negli USA (dipendenti, agenti, collaboratori)?', type: 'select', required: true, options: YN, hint: 'People working from outside the US for US customers do NOT count. We mean people physically in the US.', hintIt: 'Chi lavora da fuori gli USA per clienti americani NON conta. Intendiamo persone fisicamente negli USA.' },
    { name: 'us_payroll_w2', label: 'Did the company run official US payroll (Forms W-2)?', labelIt: 'La società ha gestito buste paga ufficiali USA (Moduli W-2)?', type: 'select', required: true, conditional: { field: 'us_people_working', value: 'Yes' }, options: YN, hint: 'If yes, we will ask your payroll provider\'s reports later.', hintIt: 'Se sì, ti chiederemo più avanti i report del provider paghe.' },
    { name: 'us_services_performed', label: 'Were any services physically performed inside the US?', labelIt: 'Sono stati svolti servizi fisicamente all\'interno degli USA?', type: 'select', required: true, options: YN, hint: 'Example: you or your team traveled to the US to do work for a client there. Selling online to US customers from abroad is NOT this.', hintIt: 'Esempio: tu o il tuo team siete andati negli USA per lavorare per un cliente lì. Vendere online a clienti USA dall\'estero NON è questo.' },
    { name: 'us_rental_property', label: 'Does the company own US real estate that it rents out?', labelIt: 'La società possiede immobili USA dati in affitto?', type: 'select', required: true, options: YN, hint: 'US rental property changes the tax treatment — we need to know.', hintIt: 'Gli immobili in affitto negli USA cambiano il trattamento fiscale — dobbiamo saperlo.' },
    { name: 'us_inventory_stored', label: 'Are products stored in US warehouses (Amazon FBA, 3PL, fulfillment centers)?', labelIt: 'I prodotti sono stoccati in magazzini USA (Amazon FBA, 3PL, centri logistici)?', type: 'select', required: true, options: YN, hint: 'This is the most common one for e-commerce: if Amazon or a logistics partner keeps your inventory in the US, answer Yes.', hintIt: 'È il caso più comune per l\'e-commerce: se Amazon o un partner logistico tiene il tuo inventario negli USA, rispondi Sì.' },
  ],

  // Schedule B / international questions, in plain words. Explicit Yes/No —
  // most clients answer No to all of them, and the step says so.
  compliance: [
    { name: 'comp_foreign_accounts', label: 'Does the company have an account at a real bank in ANOTHER country — for example a local bank in your home country, opened in the company\'s name?', labelIt: 'La società ha un conto presso una vera banca di un ALTRO paese — per esempio una banca locale del tuo paese, intestato alla società?', type: 'select', required: true, options: YN, hint: 'NONE of the accounts opened through us count: not your US banks (Mercury, Relay, Revolut, Slash), and not the fintech exchange accounts you use to receive euros and convert them (Wise, Airwallex). Even though Wise and Airwallex give you a European IBAN to get paid in euros, they are exchange services — NOT foreign bank accounts — and the money ends up in your US bank. Answer Yes ONLY if the company itself holds an account at a real bank in another country — for example an Italian, Portuguese or Emirati bank. Most clients answer No.', hintIt: 'NESSUNO dei conti aperti tramite noi conta: né le banche USA (Mercury, Relay, Revolut, Slash), né i conti fintech di cambio che usi per ricevere euro e convertirli (Wise, Airwallex). Anche se Wise e Airwallex ti danno un IBAN europeo per farti pagare in euro, sono servizi di cambio — NON conti bancari esteri — e il denaro finisce nella tua banca USA. Rispondi Sì SOLO se la società stessa ha un conto presso una vera banca di un altro paese — per esempio una banca italiana, portoghese o emiratina. La maggior parte dei clienti risponde No.' },
    { name: 'comp_foreign_accounts_country', label: 'In which country is that account?', labelIt: 'In quale paese si trova quel conto?', type: 'country', required: true, conditional: { field: 'comp_foreign_accounts', value: 'Yes' }, hint: 'The IRS return must name the country.', hintIt: 'La dichiarazione IRS deve indicare il paese.' },
    { name: 'comp_foreign_accounts_over_10k', label: 'Did that account (or all foreign accounts together) ever hold more than $10,000 at any moment during the year?', labelIt: 'Quel conto (o tutti i conti esteri insieme) ha mai superato i $10.000 in qualsiasi momento dell\'anno?', type: 'select', required: true, conditional: { field: 'comp_foreign_accounts', value: 'Yes' }, options: YN, hint: 'Above $10,000 a separate report (FBAR) is required — missing it carries heavy penalties, so we handle it for you. Even one single day above $10,000 counts.', hintIt: 'Sopra i $10.000 serve una dichiarazione separata (FBAR) — dimenticarla comporta sanzioni pesanti, quindi ce ne occupiamo noi. Conta anche un solo giorno sopra i $10.000.' },
    { name: 'comp_foreign_subsidiaries', label: 'Does the company OWN any other company, US or foreign?', labelIt: 'La società POSSIEDE altre società, USA o estere?', type: 'select', required: true, options: YN, hint: 'For example a subsidiary, a holding position, or shares above 20% in another business.', hintIt: 'Per esempio una controllata, una holding, o quote sopra il 20% di un\'altra azienda.' },
    { name: 'comp_foreign_trusts', label: 'Did the company send money to, or receive money from, a foreign trust?', labelIt: 'La società ha inviato o ricevuto denaro da un trust estero?', type: 'select', required: true, options: YN, hint: 'If you don\'t know what a trust is, your answer is No.', hintIt: 'Se non sai cos\'è un trust, la risposta è No.' },
    // Restored 2026-06-25 (Antonio): these two Schedule-B / 1065 questions were
    // dropped in the §14 MMLLC redesign (commit 9916eeb9) and asked back for.
    { name: 'mmllc_foreign_partners', label: 'Any foreign partners?', labelIt: 'Soci stranieri?', type: 'select', required: false, options: YN },
    { name: 'mmllc_assets_over_50k', label: 'Total assets over $50,000?', labelIt: 'Attivi totali superiori a $50.000?', type: 'select', required: false, options: YN },
    { name: 'comp_digital_assets', label: 'Did the company RECEIVE crypto as a payment, or SELL / convert / spend any crypto during the year?', labelIt: 'La società ha RICEVUTO crypto come pagamento, o VENDUTO / convertito / speso crypto durante l\'anno?', type: 'select', required: true, options: YN, hint: 'Only BUYING and HOLDING does not count — if the company just bought crypto and kept it, answer No. Answer Yes if crypto came IN as payment for something, or went OUT: sold, converted to dollars/euros, or used to pay for something. Simple signal: if your exchange (Kraken, Coinbase…) sent you a tax form (1099 / 1099-DA), the answer is almost certainly Yes.', hintIt: 'Solo COMPRARE e TENERE non conta — se la società ha solo comprato crypto e le ha tenute, rispondi No. Rispondi Sì se sono ENTRATE crypto come pagamento, o se sono USCITE: vendute, convertite in dollari/euro, o usate per pagare qualcosa. Segnale semplice: se il tuo exchange (Kraken, Coinbase…) ti ha inviato un modulo fiscale (1099 / 1099-DA), la risposta è quasi certamente Sì.' },
    { name: 'comp_digital_assets_scenario', label: 'What happened with the crypto?', labelIt: 'Cosa è successo con le crypto?', type: 'select', required: true, conditional: { field: 'comp_digital_assets', value: 'Yes' }, options: [
      { value: 'received_payment', label: 'We received crypto as payment from customers', labelIt: 'Abbiamo ricevuto crypto come pagamento dai clienti' },
      { value: 'sold_converted', label: 'We sold or converted crypto to dollars / euros', labelIt: 'Abbiamo venduto o convertito crypto in dollari / euro' },
      { value: 'both', label: 'Both', labelIt: 'Entrambe le cose' },
    ], hint: 'Pick the closest one. Crypto received as payment is income; crypto sold or converted creates gains or losses — different treatment, so we need to know which.', hintIt: 'Scegli quella più vicina. Le crypto ricevute come pagamento sono ricavi; quelle vendute o convertite generano guadagni o perdite — trattamento diverso, per questo lo chiediamo.' },
    { name: 'comp_digital_assets_exchange', label: 'Which exchange or wallet?', labelIt: 'Quale exchange o wallet?', type: 'text', required: true, conditional: { field: 'comp_digital_assets', value: 'Yes' }, placeholder: 'e.g. Kraken, Coinbase, Binance…', placeholderIt: 'es. Kraken, Coinbase, Binance…' },
    { name: 'comp_digital_assets_1099', label: 'Did the exchange send you a tax form (1099 / 1099-DA)?', labelIt: 'L\'exchange ti ha inviato un modulo fiscale (1099 / 1099-DA)?', type: 'select', required: true, conditional: { field: 'comp_digital_assets', value: 'Yes' }, options: YN, hint: 'US exchanges send it by early February — check the Tax Documents section of your exchange account.', hintIt: 'Gli exchange USA lo inviano entro inizio febbraio — controlla la sezione Documenti Fiscali del tuo account exchange.' },
    { name: 'comp_digital_assets_1099_file', label: 'Upload the 1099 / 1099-DA (PDF)', labelIt: 'Carica il 1099 / 1099-DA (PDF)', type: 'file', required: true, accept: '.pdf,application/pdf', conditional: { field: 'comp_digital_assets_1099', value: 'Yes' }, hint: 'This document is required to continue — it is exactly what the accountant needs. Find it in your exchange\'s Tax Documents section and come back: your progress here is saved.', hintIt: 'Questo documento è necessario per continuare — è esattamente ciò che serve al commercialista. Trovalo nella sezione Documenti Fiscali del tuo exchange e torna qui: i tuoi progressi sono salvati.' },
    { name: 'comp_digital_assets_csv', label: 'Upload the yearly transaction export from the exchange (CSV — entire year)', labelIt: 'Carica l\'export annuale delle transazioni dall\'exchange (CSV — anno intero)', type: 'file', required: true, accept: '.csv,text/csv', conditional: { field: 'comp_digital_assets_1099', value: 'No' }, hint: 'Required to continue — the bank statements do NOT show what happened on the exchange. Same rule as your bank accounts: CSV only, the entire year. Every exchange can export it: open your account, go to History or Reports, choose Export, set the dates to the full year, pick CSV. Your progress here is saved while you get it.', hintIt: 'Necessario per continuare — gli estratti conto bancari NON mostrano cosa è successo sull\'exchange. Stessa regola dei conti bancari: solo CSV, anno intero. Ogni exchange può esportarlo: apri il tuo account, vai su Storico o Report, scegli Esporta, imposta le date sull\'anno intero, seleziona CSV. I tuoi progressi sono salvati mentre lo recuperi.' },
    { name: 'comp_debt_changes', label: 'Was any company debt canceled, forgiven, or renegotiated to a lower amount?', labelIt: 'Qualche debito della società è stato cancellato, condonato o rinegoziato a un importo inferiore?', type: 'select', required: true, options: YN, hint: 'Canceled debt can count as income for the IRS — we need to know.', hintIt: 'Un debito cancellato può contare come reddito per l\'IRS — dobbiamo saperlo.' },
    { name: 'comp_asset_purchases', label: 'Did the company buy or sell big assets (equipment, vehicles, property) during the year?', labelIt: 'La società ha comprato o venduto beni importanti (attrezzature, veicoli, immobili) durante l\'anno?', type: 'select', required: true, options: YN, hint: 'Normal inventory you sell does NOT count — we mean things the company keeps and uses.', hintIt: 'Il normale inventario che vendi NON conta — intendiamo beni che la società tiene e usa.' },
    { name: 'comp_anything_else', label: 'Anything else we should know? (optional)', labelIt: 'Qualcos\'altro che dovremmo sapere? (facoltativo)', type: 'textarea', required: false, hint: 'Large unusual transactions, plans to close or sell the company, anything you are unsure about — write it here and we will check it for you.', hintIt: 'Operazioni insolite o importanti, piani di chiusura o vendita, qualsiasi dubbio — scrivilo qui e lo verifichiamo noi.' },
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
    { name: 'disclaimer_accepted', label: 'I confirm that all information is accurate. After the W-7 and 1040-NR forms are generated, I will print them in double copy, sign them, include two copies of my passport pages, and mail everything to Tony Durante LLC.', labelIt: 'Confermo che le informazioni sono corrette. Dopo la generazione dei moduli W-7 e 1040-NR, li stamperò in doppia copia, li firmerò, includerò due copie delle pagine del passaporto e spedirò tutto a Tony Durante LLC.', type: 'checkbox', required: true },
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
    { name: 'business_bank_statement', label: 'Business Bank Statement — last 3 months (optional)', labelIt: 'Estratto Conto Aziendale — ultimi 3 mesi (opzionale)', type: 'file', required: false },
    { name: 'disclaimer_accepted', label: 'Confirmation', labelIt: 'Conferma', type: 'checkbox', required: true, hint: 'I confirm that all information provided is accurate and complete.', hintIt: 'Confermo che tutte le informazioni fornite sono accurate e complete.' },
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
    { name: 'disclaimer_accepted', label: 'Confirmation', labelIt: 'Conferma', type: 'checkbox', required: true, hint: 'I confirm that all information provided is accurate and complete.', hintIt: 'Confermo che tutte le informazioni fornite sono accurate e complete.' },
  ],
  partner: [
    { name: 'partner_first_name', label: 'Partner First Name', labelIt: 'Nome Socio', type: 'text', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_last_name', label: 'Partner Last Name', labelIt: 'Cognome Socio', type: 'text', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_street', label: 'Partner Address', labelIt: 'Indirizzo Socio', type: 'text', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_city', label: 'Partner City', labelIt: 'Città Socio', type: 'text', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_state', label: 'Partner State', labelIt: 'Stato Socio', type: 'text', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_zip', label: 'Partner ZIP', labelIt: 'CAP Socio', type: 'text', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_phone', label: 'Partner Phone', labelIt: 'Telefono Socio', type: 'tel', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_email', label: 'Partner Email', labelIt: 'Email Socio', type: 'email', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
    { name: 'partner_equity_pct', label: 'Partner Ownership %', labelIt: 'Quota Socio %', type: 'number', required: true, conditional: { field: 'has_partner', value: 'Yes' } },
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
    { name: 'llc_ein', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, format: 'ein' },
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
    { name: 'articles_of_organization', label: 'Articles of Organization', labelIt: 'Atto Costitutivo', type: 'file', required: true },
    { name: 'ein_letter', label: 'EIN Letter', labelIt: 'Lettera EIN', type: 'file', required: true },
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

// ─── TD COMMUNICATION (Brand Audit) ───────────────────────
// Client intake for the branding service. Two question paths chosen by the
// enrollment's client_type (passed in as `entityType`): 'new_brand' (3 steps)
// or 'rebrand' (2 steps). These are PLACEHOLDER questions — Cris will replace
// the wording later; the wiring is what matters. All copy bilingual EN/IT.

// Shared "Brand Preferences" block — identical in both paths.
const TD_COMM_PREFERENCE_FIELDS: FieldConfig[] = [
  { name: 'brand_personality', label: 'Brand personality', labelIt: 'Personalità del brand', type: 'select', required: true, options: [
    { value: 'Professional', label: 'Professional', labelIt: 'Professionale' },
    { value: 'Creative', label: 'Creative', labelIt: 'Creativo' },
    { value: 'Bold', label: 'Bold', labelIt: 'Audace' },
    { value: 'Minimalist', label: 'Minimalist', labelIt: 'Minimalista' },
    { value: 'Luxurious', label: 'Luxurious', labelIt: 'Lussuoso' },
    { value: 'Friendly', label: 'Friendly', labelIt: 'Amichevole' },
    { value: 'Technical', label: 'Technical', labelIt: 'Tecnico' },
    { value: 'Playful', label: 'Playful', labelIt: 'Giocoso' },
  ]},
  { name: 'color_preferences', label: 'Color preferences', labelIt: 'Colori preferiti', type: 'multiselect', required: false, hint: 'Pick any colors you would like to see in your brand', hintIt: 'Scegli i colori che vorresti vedere nel tuo brand', options: [
    { value: 'Red', label: 'Red', labelIt: 'Rosso' },
    { value: 'Blue', label: 'Blue', labelIt: 'Blu' },
    { value: 'Green', label: 'Green', labelIt: 'Verde' },
    { value: 'Yellow', label: 'Yellow', labelIt: 'Giallo' },
    { value: 'Orange', label: 'Orange', labelIt: 'Arancione' },
    { value: 'Purple', label: 'Purple', labelIt: 'Viola' },
    { value: 'Black', label: 'Black', labelIt: 'Nero' },
    { value: 'White', label: 'White', labelIt: 'Bianco' },
    { value: 'Gold', label: 'Gold', labelIt: 'Oro' },
    { value: 'Silver', label: 'Silver', labelIt: 'Argento' },
  ]},
  { name: 'style_preference', label: 'Style preference', labelIt: 'Stile preferito', type: 'select', required: true, options: [
    { value: 'Modern', label: 'Modern', labelIt: 'Moderno' },
    { value: 'Classic', label: 'Classic', labelIt: 'Classico' },
    { value: 'Playful', label: 'Playful', labelIt: 'Giocoso' },
    { value: 'Corporate', label: 'Corporate', labelIt: 'Aziendale' },
    { value: 'Artistic', label: 'Artistic', labelIt: 'Artistico' },
    { value: 'Minimalist', label: 'Minimalist', labelIt: 'Minimalista' },
  ]},
  { name: 'admired_brands', label: 'Companies whose branding you admire', labelIt: 'Aziende il cui branding ammiri', type: 'textarea', required: false, hint: 'Names or links — what do you like about them?', hintIt: 'Nomi o link — cosa ti piace di loro?' },
]

const TD_COMM_DISCLAIMER_FIELD: FieldConfig = {
  name: 'disclaimer_accepted',
  label: 'I confirm this information is accurate',
  labelIt: 'Confermo che queste informazioni sono corrette',
  type: 'checkbox',
  required: true,
}

const TD_COMM_INDUSTRY_OPTIONS = [
  { value: 'Consulting', label: 'Consulting', labelIt: 'Consulenza' },
  { value: 'E-commerce', label: 'E-commerce', labelIt: 'E-commerce' },
  { value: 'Tech', label: 'Tech', labelIt: 'Tecnologia' },
  { value: 'Food & Beverage', label: 'Food & Beverage', labelIt: 'Food & Beverage' },
  { value: 'Fashion', label: 'Fashion', labelIt: 'Moda' },
  { value: 'Real Estate', label: 'Real Estate', labelIt: 'Immobiliare' },
  { value: 'Finance', label: 'Finance', labelIt: 'Finanza' },
  { value: 'Health', label: 'Health', labelIt: 'Salute' },
  { value: 'Education', label: 'Education', labelIt: 'Istruzione' },
  { value: 'Other', label: 'Other', labelIt: 'Altro' },
]

// ── New Brand path (3 steps) ──
export const TD_COMM_NEW_BRAND_STEPS: WizardStep[] = [
  { id: 'business', title: 'Business Information', titleIt: 'Informazioni Aziendali', description: 'Tell us about your business', descriptionIt: 'Raccontaci della tua attività' },
  { id: 'preferences', title: 'Brand Preferences', titleIt: 'Preferenze di Brand', description: 'Your style and aesthetic', descriptionIt: 'Il tuo stile e la tua estetica' },
  { id: 'details', title: 'Details & Review', titleIt: 'Dettagli e Revisione', description: 'Final details and materials', descriptionIt: 'Dettagli finali e materiali' },
]

export const TD_COMM_NEW_BRAND_FIELDS: Record<string, FieldConfig[]> = {
  business: [
    { name: 'business_name', label: 'Business name', labelIt: 'Nome dell\'attività', type: 'text', required: true },
    { name: 'business_description', label: 'Business description', labelIt: 'Descrizione dell\'attività', type: 'textarea', required: true, aiAssist: true, hint: 'What does your business do? (you can generate a draft)', hintIt: 'Di cosa si occupa la tua attività? (puoi generare una bozza)' },
    { name: 'industry', label: 'Industry', labelIt: 'Settore', type: 'select', required: true, options: TD_COMM_INDUSTRY_OPTIONS },
    { name: 'target_audience', label: 'Target audience', labelIt: 'Pubblico di riferimento', type: 'textarea', required: true, hint: 'Who are your ideal customers?', hintIt: 'Chi sono i tuoi clienti ideali?' },
  ],
  preferences: TD_COMM_PREFERENCE_FIELDS,
  details: [
    { name: 'slogan', label: 'Slogan or tagline', labelIt: 'Slogan o motto', type: 'text', required: false },
    { name: 'symbols_imagery', label: 'Specific symbols or imagery', labelIt: 'Simboli o immagini specifiche', type: 'textarea', required: false, hint: 'Anything you want represented in the logo', hintIt: 'Qualcosa che vuoi rappresentare nel logo' },
    { name: 'anything_else', label: 'Anything else we should know', labelIt: 'Altro che dovremmo sapere', type: 'textarea', required: false },
    { name: 'materials', label: 'Upload existing materials', labelIt: 'Carica materiali esistenti', type: 'file', required: false, hint: 'Logos, inspiration images, references', hintIt: 'Loghi, immagini di ispirazione, riferimenti' },
    TD_COMM_DISCLAIMER_FIELD,
  ],
}

// ── Rebrand path (2 steps) ──
export const TD_COMM_REBRAND_STEPS: WizardStep[] = [
  { id: 'current', title: 'Current Brand', titleIt: 'Brand Attuale', description: 'Your existing brand', descriptionIt: 'Il tuo brand esistente' },
  { id: 'direction', title: 'New Direction', titleIt: 'Nuova Direzione', description: 'Where you want to go', descriptionIt: 'Dove vuoi andare' },
]

export const TD_COMM_REBRAND_FIELDS: Record<string, FieldConfig[]> = {
  current: [
    { name: 'business_name', label: 'Business name', labelIt: 'Nome dell\'attività', type: 'text', required: true },
    { name: 'rebrand_reason', label: 'What do you want to change about your current brand?', labelIt: 'Cosa vuoi cambiare del tuo brand attuale?', type: 'textarea', required: true },
    { name: 'current_materials', label: 'Upload current logo and brand materials', labelIt: 'Carica il logo attuale e i materiali del brand', type: 'file', required: true, hint: 'Your current logo, guidelines, anything we should see', hintIt: 'Il logo attuale, le linee guida, tutto ciò che dovremmo vedere' },
  ],
  direction: [
    ...TD_COMM_PREFERENCE_FIELDS,
    TD_COMM_DISCLAIMER_FIELD,
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
    case 'td_communication':
      // For this type `entityType` carries the enrollment's client_type
      // ('new_brand' | 'rebrand'); the wizard page sets it from the enrollment.
      return entityType === 'rebrand'
        ? { steps: TD_COMM_REBRAND_STEPS, fields: TD_COMM_REBRAND_FIELDS }
        : { steps: TD_COMM_NEW_BRAND_STEPS, fields: TD_COMM_NEW_BRAND_FIELDS }
    default:
      return {
        steps: FORMATION_STEPS,
        fields: FORMATION_FIELDS,
      }
  }
}
