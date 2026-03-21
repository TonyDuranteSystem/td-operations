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
      { value: 'Wyoming', label: 'Wyoming' }, { value: 'Delaware', label: 'Delaware' },
      { value: 'Florida', label: 'Florida' }, { value: 'New Mexico', label: 'New Mexico' },
      { value: 'Texas', label: 'Texas' }, { value: 'California', label: 'California' },
      { value: 'New York', label: 'New York' }, { value: 'Nevada', label: 'Nevada' },
    ]},
    { name: 'formation_date', label: 'Formation Date', labelIt: 'Data Costituzione', type: 'date', required: true },
    { name: 'ein', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true, hint: 'e.g. 30-1482516' },
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
  documents: [
    { name: 'passport_owner', label: 'Passport Scan (Owner)', labelIt: 'Scansione Passaporto (Titolare)', type: 'file', required: true },
    { name: 'articles_of_organization', label: 'Articles of Organization', labelIt: 'Atto Costitutivo', type: 'file', required: true },
    { name: 'ein_letter', label: 'EIN Letter (CP 575)', labelIt: 'Lettera EIN (CP 575)', type: 'file', required: true },
    { name: 'ss4_form', label: 'SS-4 Form (optional)', labelIt: 'Modulo SS-4 (opzionale)', type: 'file', required: false },
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
  ],
}

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
  { name: 'member_zip', label: 'ZIP Code', labelIt: 'CAP', type: 'text', required: true },
  { name: 'member_country', label: 'Country', labelIt: 'Paese', type: 'country', required: true },
]

// ─── TAX RETURN ────────────────────────────────────────────

export const TAX_STEPS: WizardStep[] = [
  { id: 'owner', title: 'Owner Information', titleIt: 'Informazioni Titolare', description: 'Personal and tax details', descriptionIt: 'Dati personali e fiscali' },
  { id: 'company', title: 'Company Information', titleIt: 'Informazioni Società', description: 'Your LLC details', descriptionIt: 'Dettagli della tua LLC' },
  { id: 'financials', title: 'Financial Information', titleIt: 'Informazioni Finanziarie', description: 'Income, expenses, and transactions', descriptionIt: 'Entrate, spese e transazioni' },
  { id: 'documents', title: 'Documents & Review', titleIt: 'Documenti e Revisione', description: 'Upload bank statements and review', descriptionIt: 'Carica estratti conto e rivedi' },
]

export const TAX_FIELDS: Record<string, FieldConfig[]> = {
  owner: [
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
  ],
  company: [
    { name: 'llc_name', label: 'LLC Legal Name', labelIt: 'Nome Legale LLC', type: 'text', required: true },
    { name: 'ein_number', label: 'EIN Number', labelIt: 'Numero EIN', type: 'text', required: true },
    { name: 'date_of_incorporation', label: 'Date of Incorporation', labelIt: 'Data Costituzione', type: 'date', required: true },
    { name: 'state_of_incorporation', label: 'State of Incorporation', labelIt: 'Stato Costituzione', type: 'text', required: true },
    { name: 'principal_product_service', label: 'Principal Product/Service', labelIt: 'Prodotto/Servizio Principale', type: 'textarea', required: true },
    { name: 'us_business_activities', label: 'US Business Activities', labelIt: 'Attività Commerciali USA', type: 'textarea', required: true },
    { name: 'website_url', label: 'Website (optional)', labelIt: 'Sito Web (opzionale)', type: 'text', required: false },
  ],
  financials: [
    { name: 'formation_costs', label: 'Formation Costs ($)', labelIt: 'Costi di Costituzione ($)', type: 'number', required: true, hint: 'Total LLC formation expenses', hintIt: 'Spese totali di costituzione LLC' },
    { name: 'bank_contributions', label: 'Bank Contributions ($)', labelIt: 'Conferimenti Bancari ($)', type: 'number', required: true, hint: 'Capital contributed to bank account', hintIt: 'Capitale conferito su conto bancario' },
    { name: 'distributions_withdrawals', label: 'Distributions/Withdrawals ($)', labelIt: 'Distribuzioni/Prelievi ($)', type: 'number', required: true },
    { name: 'personal_expenses', label: 'Personal Expenses ($)', labelIt: 'Spese Personali ($)', type: 'number', required: true },
    { name: 'smllc_additional_comments', label: 'Additional Comments', labelIt: 'Commenti Aggiuntivi', type: 'textarea', required: false },
  ],
  documents: [
    { name: 'bank_statements', label: 'Bank Statements (CSV preferred)', labelIt: 'Estratti Conto (CSV preferito)', type: 'file', required: false, hint: 'Upload all bank statements for the tax year', hintIt: 'Carica tutti gli estratti conto dell\'anno fiscale' },
    { name: 'financial_statements', label: 'Financial Statements (optional)', labelIt: 'Rendiconti Finanziari (opzionale)', type: 'file', required: false },
    { name: 'prior_year_return', label: 'Prior Year Tax Return (optional)', labelIt: 'Dichiarazione Anno Precedente (opzionale)', type: 'file', required: false },
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate', labelIt: 'Confermo che tutte le informazioni fornite sono corrette', type: 'checkbox', required: true },
  ],
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
    { name: 'foreign_tax_id', label: 'Foreign Tax ID (optional)', labelIt: 'Codice Fiscale Estero (opzionale)', type: 'text', required: false },
    { name: 'passport_number', label: 'Passport Number', labelIt: 'Numero Passaporto', type: 'text', required: true },
    { name: 'passport_country', label: 'Passport Country', labelIt: 'Paese del Passaporto', type: 'country', required: true },
    { name: 'passport_expiry', label: 'Passport Expiry Date', labelIt: 'Scadenza Passaporto', type: 'date', required: true },
    { name: 'has_previous_itin', label: 'Do you have a previous ITIN?', labelIt: 'Hai un ITIN precedente?', type: 'select', required: true, options: [
      { value: 'No', label: 'No' },
      { value: 'Yes', label: 'Yes', labelIt: 'Sì' },
    ]},
    { name: 'previous_itin', label: 'Previous ITIN Number', labelIt: 'Numero ITIN Precedente', type: 'text', required: false, hint: 'Only if you answered Yes above', hintIt: 'Solo se hai risposto Sì sopra' },
  ],
  review: [
    { name: 'disclaimer_accepted', label: 'I confirm that all information provided is accurate and I understand the passport must be mailed physically', labelIt: 'Confermo che le informazioni sono corrette e comprendo che il passaporto deve essere spedito fisicamente', type: 'checkbox', required: true },
  ],
}

/**
 * Get the correct steps and fields based on wizard type and entity type.
 */
export function getWizardConfig(wizardType: string, entityType?: string) {
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
      return {
        steps: TAX_STEPS,
        fields: TAX_FIELDS,
      }
    case 'itin':
      return {
        steps: ITIN_STEPS,
        fields: ITIN_FIELDS,
      }
    default:
      return {
        steps: FORMATION_STEPS,
        fields: FORMATION_FIELDS,
      }
  }
}
