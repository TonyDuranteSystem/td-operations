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
    default:
      return {
        steps: FORMATION_STEPS,
        fields: FORMATION_FIELDS,
      }
  }
}
