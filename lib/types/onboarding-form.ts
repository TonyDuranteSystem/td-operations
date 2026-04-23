/**
 * Onboarding Form Types — Field configs, bilingual labels, tooltips
 * Used by: app/onboarding-form/[token]/page.tsx, lib/mcp/tools/onboarding.ts
 *
 * For clients with EXISTING LLCs who are onboarding for management services.
 * Unlike formation form (LLC to create), this collects actual company data.
 *
 * Entity Types:
 *   SMLLC = Single Member LLC
 *   MMLLC = Multi-Member LLC
 */

// ─── DB Record ──────────────────────────────────────────────

export interface OnboardingSubmission {
  id: string
  token: string
  lead_id: string | null
  contact_id: string | null
  account_id: string | null
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
  entityTypes?: ('SMLLC' | 'MMLLC')[]
  prefillFrom?: string
  options?: string[]
  isArray?: boolean
  arrayFields?: Omit<FieldConfig, 'step' | 'entityTypes' | 'isArray' | 'arrayFields'>[]
}

// ─── Step Labels ────────────────────────────────────────────

export const STEPS = {
  en: ['Owner Information', 'Company Information', 'Additional Members', 'Documents & Review'],
  it: ['Informazioni Titolare', 'Informazioni Società', 'Membri Aggiuntivi', 'Documenti e Revisione'],
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
  { key: 'owner_itin', type: 'text', required: false, step: 1 },
  { key: 'owner_itin_issue_date', type: 'date', required: false, step: 1 },

  // ═══════════════════════════════════════
  // STEP 2: Company Information (existing LLC)
  // ═══════════════════════════════════════
  { key: 'company_name', type: 'text', required: true, step: 2 },
  { key: 'state_of_formation', type: 'select', required: true, step: 2, options: [
    'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
    'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
    'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
    'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire',
    'New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio',
    'Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota',
    'Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia',
    'Wisconsin','Wyoming',
  ] },
  { key: 'formation_date', type: 'date', required: true, step: 2 },
  { key: 'ein', type: 'text', required: true, step: 2 },
  { key: 'filing_id', type: 'text', required: false, step: 2 },
  { key: 'business_purpose', type: 'textarea', required: true, step: 2 },
  { key: 'registered_agent', type: 'text', required: false, step: 2 },
  { key: 'tax_return_previous_year_filed', type: 'select', required: true, step: 2, options: ['Yes', 'No', 'Not sure'] },
  { key: 'tax_return_current_year_filed', type: 'select', required: true, step: 2, options: ['Yes', 'No', 'Not sure'] },

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

  // STEP 4: Documents & Review — no input fields, handled in UI
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
    title: 'Client Onboarding',
    subtitle: 'Company Information Form',
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
    owner_itin: 'ITIN (if available)',
    owner_itin_issue_date: 'ITIN Issue Date',

    // Step 2
    step2Title: 'Company Information',
    company_name: 'Company Name (LLC)',
    state_of_formation: 'State of Formation',
    formation_date: 'Date of Formation',
    ein: 'EIN',
    filing_id: 'State Filing ID (if available)',
    business_purpose: 'Business Activity / Purpose',
    registered_agent: 'Current Registered Agent (if any)',
    tax_return_previous_year_filed: 'Have you filed the tax return for the previous year (2024)?',
    tax_return_current_year_filed: 'Have you filed the tax return for the current year (2025)?',

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
    primaryMemberLabel: 'Managing Member (Primary Contact)',
    primaryMemberOwner: 'Owner (you)',
    primaryMemberMember: 'Member #',

    // Step 4
    step4Title: 'Documents & Review',
    passportUpload: 'Passport Scan (Owner)',
    passportMemberUpload: 'Passport Scan (Member)',
    articlesUpload: 'Articles of Organization',
    einLetterUpload: 'EIN Confirmation Letter (CP 575)',
    ss4Upload: 'SS-4 Form',
    uploadFile: 'Upload File',
    uploadRequired: 'Required',
    uploadOptional: 'Optional',

    disclaimer: 'I confirm that the information provided in this form is accurate and complete. I understand that Tony Durante LLC will use this data to onboard and manage my company.',
    disclaimerRequired: 'You must accept the disclaimer to submit',

    // Success
    successTitle: 'Form Submitted Successfully!',
    successMessage: 'Your information has been received. Our team will review your documents and begin the onboarding process.',
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
    title: 'Onboarding Cliente',
    subtitle: 'Modulo Informazioni Società',
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
    owner_itin: 'ITIN (se disponibile)',
    owner_itin_issue_date: 'Data di Rilascio ITIN',

    // Step 2
    step2Title: 'Informazioni Società',
    company_name: 'Nome Società (LLC)',
    state_of_formation: 'Stato di Formazione',
    formation_date: 'Data di Costituzione',
    ein: 'EIN',
    filing_id: 'Filing ID Statale (se disponibile)',
    business_purpose: 'Attività / Scopo della Società',
    registered_agent: 'Registered Agent Attuale (se presente)',
    tax_return_previous_year_filed: 'Hai presentato la dichiarazione dei redditi per l\'anno precedente (2024)?',
    tax_return_current_year_filed: 'Hai presentato la dichiarazione dei redditi per l\'anno corrente (2025)?',

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
    primaryMemberLabel: 'Membro Principale (Contatto Primario)',
    primaryMemberOwner: 'Titolare (tu)',
    primaryMemberMember: 'Membro #',

    // Step 4
    step4Title: 'Documenti e Revisione',
    passportUpload: 'Scansione Passaporto (Titolare)',
    passportMemberUpload: 'Scansione Passaporto (Membro)',
    articlesUpload: 'Articles of Organization',
    einLetterUpload: 'EIN Confirmation Letter (CP 575)',
    ss4Upload: 'Modulo SS-4',
    uploadFile: 'Carica File',
    uploadRequired: 'Obbligatorio',
    uploadOptional: 'Opzionale',

    disclaimer: 'Confermo che le informazioni fornite in questo modulo sono accurate e complete. Comprendo che Tony Durante LLC utilizzerà questi dati per l\'onboarding e la gestione della mia società.',
    disclaimerRequired: 'Devi accettare la dichiarazione per inviare',

    // Success
    successTitle: 'Modulo Inviato con Successo!',
    successMessage: 'Le tue informazioni sono state ricevute. Il nostro team esaminerà i documenti e avvierà il processo di onboarding.',
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
  owner_itin: {
    en: 'Your Individual Taxpayer Identification Number (e.g., 9XX-XX-XXXX). Leave blank if you don\'t have one.',
    it: 'Il tuo Individual Taxpayer Identification Number (es. 9XX-XX-XXXX). Lascia vuoto se non ne hai uno.',
  },
  owner_itin_issue_date: {
    en: 'The date your ITIN was issued (shown on the ITIN letter from the IRS). We need this to track renewal dates.',
    it: 'La data di emissione del tuo ITIN (indicata nella lettera IRS). Ci serve per calcolare la data di rinnovo.',
  },
  company_name: {
    en: 'The full legal name of your LLC as registered with the state.',
    it: 'Il nome legale completo della tua LLC come registrato presso lo stato.',
  },
  state_of_formation: {
    en: 'The US state where your LLC was originally formed.',
    it: 'Lo stato americano dove la tua LLC è stata originariamente costituita.',
  },
  formation_date: {
    en: 'The date your LLC was officially formed (from Articles of Organization).',
    it: 'La data in cui la tua LLC è stata ufficialmente costituita (dagli Articles of Organization).',
  },
  ein: {
    en: 'Your Employer Identification Number (e.g., 30-1482516). Leave blank if you don\'t have one yet.',
    it: 'Il tuo Employer Identification Number (es. 30-1482516). Lascia vuoto se non ne hai ancora uno.',
  },
  filing_id: {
    en: 'Your state filing ID number, if you have it (usually on your Articles of Organization).',
    it: 'Il numero di filing ID statale, se disponibile (di solito sugli Articles of Organization).',
  },
  business_purpose: {
    en: 'Describe your main business activity (e.g., "e-commerce", "consulting", "software development").',
    it: 'Descrivi la tua attività principale (es. "e-commerce", "consulenza", "sviluppo software").',
  },
  registered_agent: {
    en: 'The name of your current registered agent, if you have one. We will handle the change of agent.',
    it: 'Il nome del tuo registered agent attuale, se ne hai uno. Gestiremo noi il cambio agente.',
  },
  tax_return_previous_year_filed: {
    en: 'Has your LLC filed a US tax return (Form 1120, 5472, or 1065) for the previous tax year? Select "Not sure" if you don\'t know.',
    it: 'La tua LLC ha presentato la dichiarazione dei redditi USA (Form 1120, 5472, o 1065) per l\'anno fiscale precedente? Seleziona "Non sono sicuro" se non sai.',
  },
  tax_return_current_year_filed: {
    en: 'Has your LLC filed a US tax return for the current tax year? Select "Not sure" if you don\'t know.',
    it: 'La tua LLC ha presentato la dichiarazione dei redditi USA per l\'anno fiscale corrente? Seleziona "Non sono sicuro" se non sai.',
  },
  passportUpload: {
    en: 'Upload a clear scan or photo of your passport\'s data page.',
    it: 'Carica una scansione o foto leggibile della pagina dati del tuo passaporto.',
  },
  articlesUpload: {
    en: 'Upload your Articles of Organization / Certificate of Formation.',
    it: 'Carica i tuoi Articles of Organization / Certificate of Formation.',
  },
  einLetterUpload: {
    en: 'Upload your EIN confirmation letter (CP 575) or SS-4 copy, if available.',
    it: 'Carica la lettera di conferma EIN (CP 575) o copia SS-4, se disponibile.',
  },
}
