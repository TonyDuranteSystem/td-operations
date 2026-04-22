/**
 * Formation Form Types — Field configs, bilingual labels, tooltips
 * Used by: app/formation-form/[token]/page.tsx, lib/mcp/tools/formation.ts
 *
 * Entity Types:
 *   SMLLC = Single Member LLC
 *   MMLLC = Multi-Member LLC
 *
 * Entity type + state are metadata set by Antonio at form creation,
 * NOT editable fields in the form.
 */

// ─── DB Record ──────────────────────────────────────────────

export interface FormationSubmission {
  id: string
  token: string
  lead_id: string | null
  contact_id: string | null
  entity_type: 'SMLLC' | 'MMLLC'
  state: string
  language: 'en' | 'it'
  prefilled_data: Record<string, unknown>
  submitted_data: Record<string, unknown>
  changed_fields: Record<string, { old: unknown; new: unknown }>
  upload_paths: string[]
  status: 'pending' | 'sent' | 'opened' | 'completed' | 'reviewed'
  sent_at: string | null
  opened_at: string | null
  completed_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  client_ip: string | null
  client_user_agent: string | null
  created_at: string
  updated_at: string
}

// ─── Field Config ───────────────────────────────────────────

export type FieldType = 'text' | 'email' | 'phone' | 'number' | 'date' | 'select' | 'textarea' | 'country'

export interface FieldConfig {
  key: string
  type: FieldType
  required: boolean
  step: 1 | 2 | 3 | 4
  /** Which entity types use this field. Omit = all types */
  entityTypes?: ('SMLLC' | 'MMLLC')[]
  /** CRM field to pre-fill from. Format: "leads.column" or "contacts.column" */
  prefillFrom?: string
  options?: string[]
  /** If true, this is a dynamic array field (e.g., additional members) */
  isArray?: boolean
  /** Array sub-fields */
  arrayFields?: Omit<FieldConfig, 'step' | 'entityTypes' | 'isArray' | 'arrayFields'>[]
}

// ─── Step Labels ────────────────────────────────────────────

export const STEPS = {
  en: ['Owner Information', 'LLC Details', 'Additional Members', 'Documents & Review'],
  it: ['Informazioni Titolare', 'Dettagli LLC', 'Membri Aggiuntivi', 'Documenti e Revisione'],
} as const

// ─── Field Definitions ──────────────────────────────────────

export const FORM_FIELDS: FieldConfig[] = [
  // ═══════════════════════════════════════
  // STEP 1: Owner Information
  // ═══════════════════════════════════════
  { key: 'owner_first_name', type: 'text', required: true, step: 1, prefillFrom: 'leads.full_name' },
  { key: 'owner_last_name', type: 'text', required: true, step: 1 },
  { key: 'owner_email', type: 'email', required: true, step: 1, prefillFrom: 'leads.email' },
  { key: 'owner_phone', type: 'phone', required: true, step: 1, prefillFrom: 'leads.phone' },
  { key: 'owner_dob', type: 'date', required: true, step: 1 },
  { key: 'owner_nationality', type: 'country', required: true, step: 1 },
  { key: 'owner_street', type: 'text', required: true, step: 1 },
  { key: 'owner_city', type: 'text', required: true, step: 1 },
  { key: 'owner_state_province', type: 'text', required: true, step: 1 },
  { key: 'owner_zip', type: 'text', required: true, step: 1 },
  { key: 'owner_country', type: 'country', required: true, step: 1 },

  // ═══════════════════════════════════════
  // STEP 2: LLC Details
  // ═══════════════════════════════════════
  { key: 'llc_name_1', type: 'text', required: true, step: 2 },
  { key: 'llc_name_2', type: 'text', required: true, step: 2 },
  { key: 'llc_name_3', type: 'text', required: true, step: 2 },
  { key: 'business_purpose', type: 'textarea', required: true, step: 2 },

  // ═══════════════════════════════════════
  // STEP 3: Additional Members (MMLLC only)
  // ═══════════════════════════════════════
  {
    key: 'additional_members', type: 'text', required: false, step: 3, entityTypes: ['MMLLC'],
    isArray: true,
    arrayFields: [
      { key: 'member_first_name', type: 'text', required: true },
      { key: 'member_last_name', type: 'text', required: true },
      { key: 'member_email', type: 'email', required: true },
      { key: 'member_ownership_pct', type: 'number', required: true },
      { key: 'member_dob', type: 'date', required: true },
      { key: 'member_nationality', type: 'country', required: true },
      { key: 'member_street', type: 'text', required: true },
      { key: 'member_city', type: 'text', required: true },
      { key: 'member_state_province', type: 'text', required: false },
      { key: 'member_zip', type: 'text', required: true },
      { key: 'member_country', type: 'country', required: true },
    ],
  },

  // ═══════════════════════════════════════
  // STEP 4: Documents & Review (no input fields — handled in UI)
  // ═══════════════════════════════════════
]

// ─── Get fields for a specific entity type + step ───────────

export function getFieldsForStep(entityType: string, step: number): FieldConfig[] {
  return FORM_FIELDS.filter(f => {
    if (f.step !== step) return false
    if (!f.entityTypes) return true
    return f.entityTypes.includes(entityType as 'SMLLC' | 'MMLLC')
  })
}

// ─── Bilingual Labels ───────────────────────────────────────

export const LABELS = {
  en: {
    // Page chrome
    title: 'LLC Formation',
    subtitle: 'Client Information Form',
    step: 'Step',
    of: 'of',
    next: 'Next',
    back: 'Back',
    submit: 'Submit Form',
    submitting: 'Submitting...',
    required: 'Required',
    prefilled: 'Pre-filled',
    changed: 'Changed',

    // Email gate
    emailGateTitle: 'Verify Your Identity',
    emailGateMessage: 'Enter the email address associated with this form to access it.',
    emailGateButton: 'Access Form',
    emailGateError: 'The email does not match our records. Please try again.',
    emailPlaceholder: 'your@email.com',

    // Step 1
    step1Title: 'Owner Information',
    owner_first_name: 'First Name',
    owner_last_name: 'Last Name',
    owner_email: 'Email Address',
    owner_phone: 'Phone Number',
    owner_dob: 'Date of Birth',
    owner_nationality: 'Nationality / Citizenship',
    owner_street: 'Street Address',
    owner_city: 'City',
    owner_state_province: 'State / Province',
    owner_zip: 'ZIP / Postal Code',
    owner_country: 'Country of Residence',

    // Step 2
    step2Title: 'LLC Details',
    llc_name_1: 'Preferred Company Name (1st choice)',
    llc_name_2: 'Alternative Name (2nd choice)',
    llc_name_3: 'Alternative Name (3rd choice)',
    business_purpose: 'Business Activity / Purpose',

    // Step 3
    step3Title: 'Additional Members',
    step3Empty: 'No additional members added yet.',
    additional_members: 'Members / Partners',
    member_first_name: 'First Name',
    member_last_name: 'Last Name',
    member_email: 'Email',
    member_ownership_pct: 'Ownership %',
    member_dob: 'Date of Birth',
    member_nationality: 'Nationality',
    member_street: 'Street Address',
    member_city: 'City',
    member_state_province: 'State / Province',
    member_zip: 'ZIP / Postal Code',
    member_country: 'Country',
    addMember: '+ Add Member',
    removeMember: 'Remove',
    primaryContactTitle: 'Primary Contact',
    primaryContactHelp: 'The primary contact is your main point of contact with our firm and will manage the company portal. Pick the person who will handle communications.',
    primaryContactOwner: '(you — the person filling this form)',

    // Step 4
    step4Title: 'Documents & Review',
    passportUpload: 'Passport Scan (Owner)',
    passportMemberUpload: 'Passport Scan (Member)',
    uploadFile: 'Upload File',
    uploadRequired: 'Required',

    disclaimer: 'I confirm that the information provided in this form is accurate and complete. I understand that Tony Durante LLC will use this data to prepare the formation of my LLC.',
    disclaimerRequired: 'You must accept the disclaimer to submit',

    // Success
    successTitle: 'Form Submitted Successfully!',
    successMessage: 'Your information has been received. We will begin the LLC formation process and contact you with updates.',
    successTimestamp: 'Submitted on',

    // Errors
    notFound: 'Form Not Found',
    notFoundMessage: 'This form link is not valid or has expired.',
    loading: 'Loading form...',
    errorSubmit: 'An error occurred while submitting. Please try again.',
    alreadySubmitted: 'This form has already been submitted.',
    alreadySubmittedMessage: 'If you need to make changes, please contact us.',
  },
  it: {
    // Page chrome
    title: 'Costituzione LLC',
    subtitle: 'Modulo Informazioni Cliente',
    step: 'Passo',
    of: 'di',
    next: 'Avanti',
    back: 'Indietro',
    submit: 'Invia Modulo',
    submitting: 'Invio in corso...',
    required: 'Obbligatorio',
    prefilled: 'Precompilato',
    changed: 'Modificato',

    // Email gate
    emailGateTitle: 'Verifica la tua identità',
    emailGateMessage: 'Inserisci l\'indirizzo email associato a questo modulo per accedervi.',
    emailGateButton: 'Accedi al Modulo',
    emailGateError: 'L\'email non corrisponde ai nostri dati. Riprova.',
    emailPlaceholder: 'tua@email.com',

    // Step 1
    step1Title: 'Informazioni Titolare',
    owner_first_name: 'Nome',
    owner_last_name: 'Cognome',
    owner_email: 'Email',
    owner_phone: 'Telefono',
    owner_dob: 'Data di Nascita',
    owner_nationality: 'Nazionalità / Cittadinanza',
    owner_street: 'Indirizzo',
    owner_city: 'Città',
    owner_state_province: 'Stato / Provincia',
    owner_zip: 'CAP / Codice Postale',
    owner_country: 'Paese di Residenza',

    // Step 2
    step2Title: 'Dettagli LLC',
    llc_name_1: 'Nome Società Preferito (1ª scelta)',
    llc_name_2: 'Nome Alternativo (2ª scelta)',
    llc_name_3: 'Nome Alternativo (3ª scelta)',
    business_purpose: 'Attività / Scopo della Società',

    // Step 3
    step3Title: 'Membri Aggiuntivi',
    step3Empty: 'Nessun membro aggiuntivo aggiunto.',
    additional_members: 'Membri / Soci',
    member_first_name: 'Nome',
    member_last_name: 'Cognome',
    member_email: 'Email',
    member_ownership_pct: 'Quota %',
    member_dob: 'Data di Nascita',
    member_nationality: 'Nazionalità',
    member_street: 'Indirizzo',
    member_city: 'Città',
    member_state_province: 'Stato / Provincia',
    member_zip: 'CAP',
    member_country: 'Paese',
    addMember: '+ Aggiungi Membro',
    removeMember: 'Rimuovi',
    primaryContactTitle: 'Contatto Principale',
    primaryContactHelp: 'Il contatto principale è la persona di riferimento con il nostro studio e gestirà il portale aziendale. Scegli chi si occuperà delle comunicazioni.',
    primaryContactOwner: '(tu — la persona che compila questo modulo)',

    // Step 4
    step4Title: 'Documenti e Revisione',
    passportUpload: 'Scansione Passaporto (Titolare)',
    passportMemberUpload: 'Scansione Passaporto (Membro)',
    uploadFile: 'Carica File',
    uploadRequired: 'Obbligatorio',

    disclaimer: 'Confermo che le informazioni fornite in questo modulo sono accurate e complete. Comprendo che Tony Durante LLC utilizzerà questi dati per la costituzione della mia LLC.',
    disclaimerRequired: 'Devi accettare la dichiarazione per inviare',

    // Success
    successTitle: 'Modulo Inviato con Successo!',
    successMessage: 'Le tue informazioni sono state ricevute. Inizieremo il processo di costituzione della LLC e ti contatteremo con aggiornamenti.',
    successTimestamp: 'Inviato il',

    // Errors
    notFound: 'Modulo Non Trovato',
    notFoundMessage: 'Questo link non è valido o è scaduto.',
    loading: 'Caricamento modulo...',
    errorSubmit: 'Si è verificato un errore durante l\'invio. Riprova.',
    alreadySubmitted: 'Questo modulo è già stato inviato.',
    alreadySubmittedMessage: 'Se hai bisogno di modifiche, contattaci.',
  },
} as const

export type LabelKey = keyof typeof LABELS.en

// ─── Bilingual Tooltips ─────────────────────────────────────

export const TOOLTIPS: Record<string, { en: string; it: string }> = {
  owner_first_name: {
    en: 'Your legal first name as it appears on your passport.',
    it: 'Il tuo nome legale come appare sul passaporto.',
  },
  owner_last_name: {
    en: 'Your legal last name as it appears on your passport.',
    it: 'Il tuo cognome legale come appare sul passaporto.',
  },
  owner_dob: {
    en: 'Your date of birth as it appears on your passport.',
    it: 'La tua data di nascita come appare sul passaporto.',
  },
  owner_nationality: {
    en: 'Your nationality / citizenship as it appears on your passport.',
    it: 'La tua nazionalità / cittadinanza come appare sul passaporto.',
  },
  owner_street: {
    en: 'Your current residential street address (not a P.O. Box).',
    it: 'Il tuo indirizzo di residenza attuale (non casella postale).',
  },
  llc_name_1: {
    en: 'The name you want for your LLC. It must end with "LLC" or "L.L.C." — we\'ll add it if needed. We\'ll check availability with the state.',
    it: 'Il nome che desideri per la tua LLC. Deve terminare con "LLC" o "L.L.C." — lo aggiungeremo se necessario. Verificheremo la disponibilità con lo stato.',
  },
  llc_name_2: {
    en: 'Backup name in case your first choice is not available.',
    it: 'Nome alternativo nel caso la prima scelta non sia disponibile.',
  },
  llc_name_3: {
    en: 'Third backup name in case neither of your first two choices is available.',
    it: 'Terzo nome alternativo nel caso le prime due scelte non siano disponibili.',
  },
  business_purpose: {
    en: 'Describe your main business activity (e.g., "e-commerce", "consulting", "software development").',
    it: 'Descrivi la tua attività principale (es. "e-commerce", "consulenza", "sviluppo software").',
  },
  passportUpload: {
    en: 'Upload a clear scan or photo of your passport\'s data page.',
    it: 'Carica una scansione o foto leggibile della pagina dati del tuo passaporto.',
  },
}
