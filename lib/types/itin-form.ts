/**
 * ITIN Form Types ‚Äî Field configs, bilingual labels, tooltips
 * Used by: app/itin-form/[token]/page.tsx, lib/mcp/tools/itin-form.ts
 *
 * ITIN = Individual Taxpayer Identification Number (IRS Form W-7)
 *
 * 3 steps:
 *   Step 1: Personal Information (W-7 Section 1-3)
 *   Step 2: Foreign Address & Entry Info (W-7 Section 4-6)
 *   Step 3: Documents & Review (passport upload + review)
 *
 * The form can be linked to a lead (pre-formation) or account+contact (existing client).
 * Antonio is IRS Certified Acceptance Agent (CAA) ‚Äî prepares COA.
 */

// ‚îÄ‚îÄ‚îÄ DB Record ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export interface ITINSubmission {
  id: string
  token: string
  lead_id: string | null
  account_id: string | null
  contact_id: string | null
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

// ‚îÄ‚îÄ‚îÄ Field Config ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export type FieldType = 'text' | 'email' | 'phone' | 'number' | 'date' | 'select' | 'textarea' | 'country'

export interface FieldConfig {
  key: string
  type: FieldType
  required: boolean
  step: 1 | 2 | 3
  /** CRM field to pre-fill from. Format: "leads.column" or "contacts.column" */
  prefillFrom?: string
  options?: string[]
}

// ‚îÄ‚îÄ‚îÄ Step Labels ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export const STEPS = {
  en: ['Personal Information', 'Foreign Address & Entry Info', 'Documents & Review'],
  it: ['Informazioni Personali', 'Indirizzo Estero e Info Ingresso', 'Documenti e Revisione'],
} as const

// ‚îÄ‚îÄ‚îÄ Field Definitions ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export const FORM_FIELDS: FieldConfig[] = [
  // ‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê
  // STEP 1: Personal Information (W-7 Lines 1-3)
  // ‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê
  { key: 'first_name', type: 'text', required: true, step: 1, prefillFrom: 'leads.full_name' },
  { key: 'last_name', type: 'text', required: true, step: 1 },
  { key: 'name_at_birth', type: 'text', required: false, step: 1 },
  { key: 'email', type: 'email', required: true, step: 1, prefillFrom: 'leads.email' },
  { key: 'phone', type: 'phone', required: true, step: 1, prefillFrom: 'leads.phone' },
  { key: 'dob', type: 'date', required: true, step: 1 },
  { key: 'country_of_birth', type: 'country', required: true, step: 1 },
  { key: 'city_of_birth', type: 'text', required: true, step: 1 },
  { key: 'gender', type: 'select', required: true, step: 1, options: ['Male', 'Female'] },
  { key: 'citizenship', type: 'country', required: true, step: 1, prefillFrom: 'contacts.citizenship' },

  // ‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê
  // STEP 2: Foreign Address & Entry Info (W-7 Lines 4-6)
  // ‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê
  { key: 'foreign_street', type: 'text', required: true, step: 2 },
  { key: 'foreign_city', type: 'text', required: true, step: 2 },
  { key: 'foreign_state_province', type: 'text', required: false, step: 2 },
  { key: 'foreign_zip', type: 'text', required: true, step: 2 },
  { key: 'foreign_country', type: 'country', required: true, step: 2 },
  { key: 'foreign_tax_id', type: 'text', required: false, step: 2 },
  { key: 'us_visa_type', type: 'text', required: false, step: 2 },
  { key: 'us_visa_number', type: 'text', required: false, step: 2 },
  { key: 'us_entry_date', type: 'date', required: false, step: 2 },
  { key: 'passport_number', type: 'text', required: true, step: 2 },
  { key: 'passport_country', type: 'country', required: true, step: 2 },
  { key: 'passport_expiry', type: 'date', required: true, step: 2 },
  { key: 'has_previous_itin', type: 'select', required: true, step: 2, options: ['Yes', 'No'] },
  { key: 'previous_itin', type: 'text', required: false, step: 2 },

  // ‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê
  // STEP 3: Documents & Review (no input fields ‚Äî handled in UI)
  // ‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê‚ïê
]

// ‚îÄ‚îÄ‚îÄ Get fields for a specific step ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export function getFieldsForStep(step: number): FieldConfig[] {
  return FORM_FIELDS.filter(f => f.step === step)
}

// ‚îÄ‚îÄ‚îÄ Bilingual Labels ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export const LABELS = {
  en: {
    // Page chrome
    title: 'ITIN Application',
    subtitle: 'Individual Taxpayer Identification Number',
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

    // Step 1: Personal Information
    step1Title: 'Personal Information',
    first_name: 'First Name',
    last_name: 'Last Name',
    name_at_birth: 'Name at Birth (if different)',
    email: 'Email Address',
    phone: 'Phone Number',
    dob: 'Date of Birth',
    country_of_birth: 'Country of Birth',
    city_of_birth: 'City / Place of Birth',
    gender: 'Gender',
    citizenship: 'Country of Citizenship',

    // Step 2: Foreign Address & Entry Info
    step2Title: 'Foreign Address & Entry Information',
    foreign_street: 'Street Address (Foreign)',
    foreign_city: 'City',
    foreign_state_province: 'State / Province',
    foreign_zip: 'ZIP / Postal Code',
    foreign_country: 'Country',
    foreign_tax_id: 'Foreign Tax Identification Number',
    us_visa_type: 'US Visa Type (if applicable)',
    us_visa_number: 'US Visa Number (if applicable)',
    us_entry_date: 'Date of US Entry (if applicable)',
    passport_number: 'Passport Number',
    passport_country: 'Passport Country of Issue',
    passport_expiry: 'Passport Expiration Date',
    has_previous_itin: 'Have you previously had an ITIN?',
    previous_itin: 'Previous ITIN Number',

    // Step 3: Documents & Review
    step3Title: 'Documents & Review',
    passportUpload: 'Passport Scan (color copy, data page)',
    passportUpload2: 'Passport Scan (second copy)',
    uploadFile: 'Upload File',
    uploadRequired: 'Required',

    // Disclaimer
    disclaimer: 'I confirm that the information provided is accurate and complete. I understand that Tony Durante LLC, as an IRS Certified Acceptance Agent (CAA), will use this data to prepare and submit the W-7 form for my ITIN application. I will also need to sign the W-7 form and 1040-NR tax return in wet ink and mail them to Tony Durante LLC.',
    disclaimerRequired: 'You must accept the disclaimer to submit',

    // Success
    successTitle: 'Form Submitted Successfully!',
    successMessage: 'Your information has been received. We will prepare the W-7 form and 1040-NR tax return for your signature. You will receive them by email with mailing instructions.',
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
    title: 'Richiesta ITIN',
    subtitle: 'Numero di Identificazione Fiscale Individuale',
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
    emailGateTitle: 'Verifica la tua identit√†',
    emailGateMessage: 'Inserisci l\'indirizzo email associato a questo modulo per accedervi.',
    emailGateButton: 'Accedi al Modulo',
    emailGateError: 'L\'email non corrisponde ai nostri dati. Riprova.',
    emailPlaceholder: 'tua@email.com',

    // Step 1: Informazioni Personali
    step1Title: 'Informazioni Personali',
    first_name: 'Nome',
    last_name: 'Cognome',
    name_at_birth: 'Nome alla Nascita (se diverso)',
    email: 'Indirizzo Email',
    phone: 'Numero di Telefono',
    dob: 'Data di Nascita',
    country_of_birth: 'Paese di Nascita',
    city_of_birth: 'Citt√† / Luogo di Nascita',
    gender: 'Sesso',
    citizenship: 'Paese di Cittadinanza',

    // Step 2: Indirizzo Estero e Info Ingresso
    step2Title: 'Indirizzo Estero e Informazioni di Ingresso',
    foreign_street: 'Indirizzo (Estero)',
    foreign_city: 'Citt√†',
    foreign_state_province: 'Stato / Provincia',
    foreign_zip: 'CAP / Codice Postale',
    foreign_country: 'Paese',
    foreign_tax_id: 'Codice Fiscale Estero',
    us_visa_type: 'Tipo di Visto USA (se applicabile)',
    us_visa_number: 'Numero Visto USA (se applicabile)',
    us_entry_date: 'Data di Ingresso negli USA (se applicabile)',
    passport_number: 'Numero Passaporto',
    passport_country: 'Paese di Emissione Passaporto',
    passport_expiry: 'Data di Scadenza Passaporto',
    has_previous_itin: 'Hai avuto un ITIN in precedenza?',
    previous_itin: 'Numero ITIN Precedente',

    // Step 3: Documenti e Revisione
    step3Title: 'Documenti e Revisione',
    passportUpload: 'Scansione Passaporto (copia a colori, pagina dati)',
    passportUpload2: 'Scansione Passaporto (seconda copia)',
    uploadFile: 'Carica File',
    uploadRequired: 'Obbligatorio',

    // Disclaimer
    disclaimer: 'Confermo che le informazioni fornite sono accurate e complete. Comprendo che Tony Durante LLC, in qualit√† di Agente di Accettazione Certificato IRS (CAA), utilizzer√† questi dati per preparare e inviare il modulo W-7 per la mia richiesta ITIN. Dovr√≤ anche firmare il modulo W-7 e la dichiarazione dei redditi 1040-NR con firma autografa e spedirli a Tony Durante LLC.',
    disclaimerRequired: 'Devi accettare la dichiarazione per inviare',

    // Success
    successTitle: 'Modulo Inviato con Successo!',
    successMessage: 'Le tue informazioni sono state ricevute. Prepareremo il modulo W-7 e la dichiarazione dei redditi 1040-NR per la tua firma. Li riceverai via email con le istruzioni per la spedizione.',
    successTimestamp: 'Inviato il',

    // Errors
    notFound: 'Modulo Non Trovato',
    notFoundMessage: 'Questo link non √® valido o √® scaduto.',
    loading: 'Caricamento modulo...',
    errorSubmit: 'Si √® verificato un errore durante l\'invio. Riprova.',
    alreadySubmitted: 'Questo modulo √® gi√† stato inviato.',
    alreadySubmittedMessage: 'Se hai bisogno di modifiche, contattaci.',
  },
} as const

export type LabelKey = keyof typeof LABELS.en

// ‚îÄ‚îÄ‚îÄ Bilingual Tooltips ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ

export const TOOLTIPS: Record<string, { en: string; it: string }> = {
  first_name: {
    en: 'Your legal first name exactly as it appears on your passport.',
    it: 'Il tuo nome legale esattamente come appare sul passaporto.',
  },
  last_name: {
    en: 'Your legal last name exactly as it appears on your passport.',
    it: 'Il tuo cognome legale esattamente come appare sul passaporto.',
  },
  name_at_birth: {
    en: 'Only fill this if your name at birth was different from your current legal name.',
    it: 'Compila solo se il tuo nome alla nascita era diverso dal tuo nome legale attuale.',
  },
  dob: {
    en: 'Your date of birth as it appears on your passport.',
    it: 'La tua data di nascita come appare sul passaporto.',
  },
  city_of_birth: {
    en: 'The city and state/province where you were born, as on your passport.',
    it: 'La citt√† e stato/provincia dove sei nato, come appare sul passaporto.',
  },
  citizenship: {
    en: 'Your country of citizenship as shown on your passport.',
    it: 'Il tuo paese di cittadinanza come indicato sul passaporto.',
  },
  foreign_street: {
    en: 'Your current permanent residential address outside the US.',
    it: 'Il tuo indirizzo di residenza permanente attuale fuori dagli USA.',
  },
  foreign_tax_id: {
    en: 'Your tax identification number in your home country (e.g., Codice Fiscale for Italy).',
    it: 'Il tuo codice fiscale nel tuo paese di origine.',
  },
  us_visa_type: {
    en: 'If you have a US visa, enter the type (e.g., B1, B2, F1, H1B). Leave blank if not applicable.',
    it: 'Se hai un visto USA, inserisci il tipo (es. B1, B2, F1, H1B). Lascia vuoto se non applicabile.',
  },
  passport_number: {
    en: 'Your passport number. Make sure it matches the passport scan you upload.',
    it: 'Il numero del tuo passaporto. Assicurati che corrisponda alla scansione che caricherai.',
  },
  passport_expiry: {
    en: 'Your passport must be valid (not expired) at the time of ITIN application.',
    it: 'Il passaporto deve essere valido (non scaduto) al momento della richiesta ITIN.',
  },
  has_previous_itin: {
    en: 'Select Yes if you have ever had an ITIN number before, even if it has expired.',
    it: 'Seleziona S√¨ se hai mai avuto un numero ITIN in precedenza, anche se √® scaduto.',
  },
  passportUpload: {
    en: 'Upload a clear color scan or photo of your passport data page. Two copies are required by the IRS.',
    it: 'Carica una scansione a colori chiara o foto della pagina dati del tuo passaporto. L\'IRS richiede due copie.',
  },
}
