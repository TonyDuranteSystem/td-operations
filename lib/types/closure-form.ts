/**
 * Closure Form Types — Field configs, bilingual labels, tooltips
 * Used by: app/closure-form/[token]/page.tsx, lib/mcp/tools/closure.ts
 *
 * Company Closure = one-time service to dissolve an existing LLC.
 * Collects data about the LLC to be closed (name, EIN, state, RA, tax history).
 *
 * IMPORTANT: The offer price does NOT include any outstanding state fees/taxes.
 * The State Compliance Check stage verifies this before filing dissolution.
 */

// ─── DB Record ──────────────────────────────────────────────

export interface ClosureSubmission {
  id: string
  token: string
  lead_id: string | null
  contact_id: string | null
  account_id: string | null
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
  step: 1 | 2 | 3
  options?: string[]
  prefillFrom?: string
}

// ─── Step Labels ────────────────────────────────────────────

export const STEPS = {
  en: ['Contact Information', 'Company Details', 'Documents & Review'],
  it: ['Informazioni di Contatto', 'Dettagli Società', 'Documenti e Revisione'],
} as const

// ─── Field Definitions ──────────────────────────────────────

export const FORM_FIELDS: FieldConfig[] = [
  // ═══════════════════════════════════════
  // STEP 1: Contact Information
  // ═══════════════════════════════════════
  { key: 'owner_first_name', type: 'text', required: true, step: 1, prefillFrom: 'leads.full_name' },
  { key: 'owner_last_name', type: 'text', required: true, step: 1 },
  { key: 'owner_email', type: 'email', required: true, step: 1, prefillFrom: 'leads.email' },
  { key: 'owner_phone', type: 'phone', required: true, step: 1, prefillFrom: 'leads.phone' },

  // ═══════════════════════════════════════
  // STEP 2: Company Details (LLC to close)
  // ═══════════════════════════════════════
  { key: 'llc_name', type: 'text', required: true, step: 2 },
  { key: 'llc_ein', type: 'text', required: false, step: 2 },
  { key: 'llc_state', type: 'select', required: true, step: 2, options: [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
    'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
    'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
    'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
    'Wisconsin', 'Wyoming',
  ] },
  { key: 'llc_formation_year', type: 'number', required: true, step: 2 },
  { key: 'registered_agent', type: 'text', required: false, step: 2 },
  { key: 'tax_returns_filed', type: 'select', required: true, step: 2, options: ['yes', 'no', 'not_sure'] },
  { key: 'tax_returns_years', type: 'text', required: false, step: 2 },

  // ═══════════════════════════════════════
  // STEP 3: Documents & Review (handled in UI — upload + disclaimer)
  // ═══════════════════════════════════════
]

// ─── Get fields for a specific step ─────────────────────────

export function getFieldsForStep(step: number): FieldConfig[] {
  return FORM_FIELDS.filter(f => f.step === step)
}

// ─── Bilingual Labels ───────────────────────────────────────

export const LABELS = {
  en: {
    // Page chrome
    title: 'Company Closure',
    subtitle: 'LLC Dissolution Information Form',
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
    step1Title: 'Contact Information',
    owner_first_name: 'First Name',
    owner_last_name: 'Last Name',
    owner_email: 'Email Address',
    owner_phone: 'Phone Number',

    // Step 2
    step2Title: 'Company to Close',
    llc_name: 'LLC Legal Name (as registered)',
    llc_ein: 'EIN (if available)',
    llc_state: 'State of Formation',
    llc_formation_year: 'Year of Formation',
    registered_agent: 'Current Registered Agent (if known)',
    tax_returns_filed: 'Have tax returns been filed for this LLC?',
    tax_returns_years: 'Which years? (e.g., 2024, 2025)',
    tax_returns_filed_yes: 'Yes',
    tax_returns_filed_no: 'No',
    tax_returns_filed_not_sure: 'Not sure',

    // Step 3
    step3Title: 'Documents & Review',
    uploadArticles: 'Articles of Organization (if available)',
    uploadEinLetter: 'EIN Letter (if available)',
    uploadOther: 'Other relevant documents',
    uploadFile: 'Upload File',
    uploadOptional: 'Optional',

    disclaimer: 'I confirm that the information provided is accurate. I understand that the closure fee does not include any outstanding state fees, taxes, or penalties that may need to be paid before the state accepts the dissolution.',
    disclaimerRequired: 'You must accept the disclaimer to submit',

    // Success
    successTitle: 'Form Submitted Successfully!',
    successMessage: 'Your information has been received. We will review the details and begin the dissolution process. We will contact you if any outstanding state fees need to be resolved first.',
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
    title: 'Chiusura Società',
    subtitle: 'Modulo Informazioni per Dissoluzione LLC',
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
    step1Title: 'Informazioni di Contatto',
    owner_first_name: 'Nome',
    owner_last_name: 'Cognome',
    owner_email: 'Email',
    owner_phone: 'Telefono',

    // Step 2
    step2Title: 'Società da Chiudere',
    llc_name: 'Nome Legale LLC (come registrata)',
    llc_ein: 'EIN (se disponibile)',
    llc_state: 'Stato di Costituzione',
    llc_formation_year: 'Anno di Costituzione',
    registered_agent: 'Registered Agent Attuale (se noto)',
    tax_returns_filed: 'Sono state presentate le tax return per questa LLC?',
    tax_returns_years: 'Quali anni? (es. 2024, 2025)',
    tax_returns_filed_yes: 'Sì',
    tax_returns_filed_no: 'No',
    tax_returns_filed_not_sure: 'Non sono sicuro/a',

    // Step 3
    step3Title: 'Documenti e Revisione',
    uploadArticles: 'Articles of Organization (se disponibile)',
    uploadEinLetter: 'Lettera EIN (se disponibile)',
    uploadOther: 'Altri documenti rilevanti',
    uploadFile: 'Carica File',
    uploadOptional: 'Opzionale',

    disclaimer: 'Confermo che le informazioni fornite sono accurate. Comprendo che il costo della chiusura non include eventuali tasse, commissioni o sanzioni arretrate dovute allo Stato che potrebbero dover essere pagate prima che lo Stato accetti la dissoluzione.',
    disclaimerRequired: 'Devi accettare la dichiarazione per inviare',

    // Success
    successTitle: 'Modulo Inviato con Successo!',
    successMessage: 'Le tue informazioni sono state ricevute. Esamineremo i dettagli e inizieremo il processo di dissoluzione. Ti contatteremo se ci sono tasse arretrate da risolvere prima.',
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
    en: 'Your legal first name.',
    it: 'Il tuo nome legale.',
  },
  owner_last_name: {
    en: 'Your legal last name.',
    it: 'Il tuo cognome legale.',
  },
  llc_name: {
    en: 'The exact legal name of the LLC as registered with the state. Include "LLC" at the end.',
    it: 'Il nome legale esatto della LLC come registrata presso lo stato. Includi "LLC" alla fine.',
  },
  llc_ein: {
    en: 'The Employer Identification Number assigned by the IRS. Format: XX-XXXXXXX.',
    it: 'Il numero di identificazione fiscale assegnato dall\'IRS. Formato: XX-XXXXXXX.',
  },
  llc_state: {
    en: 'The US state where the LLC was originally formed.',
    it: 'Lo stato USA in cui la LLC è stata originariamente costituita.',
  },
  llc_formation_year: {
    en: 'The year the LLC was formed.',
    it: 'L\'anno in cui la LLC è stata costituita.',
  },
  registered_agent: {
    en: 'The company or person currently serving as Registered Agent (e.g., Harbor Compliance, Northwest, etc.).',
    it: 'La società o persona che attualmente funge da Registered Agent (es. Harbor Compliance, Northwest, ecc.).',
  },
  tax_returns_filed: {
    en: 'Whether US tax returns (Form 1065 or 5472) have been filed for this LLC.',
    it: 'Se sono state presentate le dichiarazioni dei redditi USA (Form 1065 o 5472) per questa LLC.',
  },
  tax_returns_years: {
    en: 'List the tax years for which returns were filed. This helps us determine if the LLC is in good standing.',
    it: 'Elenca gli anni fiscali per cui sono state presentate le dichiarazioni. Questo ci aiuta a determinare se la LLC è in regola.',
  },
}
