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
    label: 'Your bank accounts — upload the CSV export for the entire year',
    labelIt: 'I tuoi conti bancari — carica l\'export CSV dell\'intero anno',
    type: 'repeater',
    repeaterRequired: true,
    hint: 'Please upload ONLY CSV files, and the ENTIRE year (January 1 – December 31), not a piece of it. This file lets us prepare your Profit & Loss and Balance Sheet for you — accurately and at no extra cost. Every bank lets you export it: in your online banking, open the account, choose Export/Download, set the dates to the full year, and pick CSV. Add one section per bank account.',
    hintIt: 'Carica SOLO file CSV, e l\'INTERO anno (1 gennaio – 31 dicembre), non una parte. Questo file ci permette di preparare per te il Conto Economico e lo Stato Patrimoniale — con precisione e senza costi aggiuntivi. Ogni banca permette di esportarlo: nell\'online banking, apri il conto, scegli Esporta/Scarica, imposta le date sull\'anno intero e seleziona CSV. Aggiungi una sezione per ogni conto bancario.',
    repeaterAddLabel: 'Add a bank account',
    repeaterAddLabelIt: 'Aggiungi un conto bancario',
    repeaterFields: [
      { name: 'bank_name', label: 'Bank name', labelIt: 'Nome della banca', type: 'text', required: true, placeholder: 'e.g. Mercury, Wise, Chase…', placeholderIt: 'es. Mercury, Wise, Chase…' },
      { name: 'account_label', label: 'Account nickname / last 4 digits (if you have more than one account at this bank)', labelIt: 'Nome conto / ultime 4 cifre (se hai più conti nella stessa banca)', type: 'text', required: false },
      { name: 'account_kind', label: 'Account type', labelIt: 'Tipo di conto', type: 'select', required: true, options: [
        { value: 'checking', label: 'Bank account (checking)', labelIt: 'Conto corrente' },
        { value: 'credit_card', label: 'Credit card', labelIt: 'Carta di credito' },
      ] },
      { name: 'statements', label: 'CSV export — entire year', labelIt: 'Export CSV — anno intero', type: 'file', required: true, accept: '.csv,text/csv', hint: 'Only CSV. The entire year, not a piece of it.', hintIt: 'Solo CSV. L\'anno intero, non una parte.' },
    ],
  },
  { name: 'financial_statements', label: 'Financial Statements (optional)', labelIt: 'Rendiconti Finanziari (opzionale)', type: 'file', required: false },
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
