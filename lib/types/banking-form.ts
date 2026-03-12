/**
 * Banking Form Types — Field configs, bilingual labels, tooltips
 * Used by: app/banking-form/[token]/page.tsx, lib/mcp/tools/banking.ts
 *
 * Multi-provider banking application form (2 steps):
 *   Step 1: Personal Information
 *   Step 2: Business Information & Documents
 *
 * Providers: payset (EUR IBAN), relay (USD), future others.
 * No entity type variation — all fields apply to all submissions.
 */

// ─── Provider Config ─────────────────────────────────────────

export type BankingProvider = 'payset' | 'relay'

export interface ProviderConfig {
  id: BankingProvider
  currency: string
  labels: {
    en: { title: string; subtitle: string; disclaimer: string; successMessage: string; monthlyVolumeLabel: string }
    it: { title: string; subtitle: string; disclaimer: string; successMessage: string; monthlyVolumeLabel: string }
  }
}

export const PROVIDERS: Record<BankingProvider, ProviderConfig> = {
  payset: {
    id: 'payset',
    currency: 'EUR',
    labels: {
      en: {
        title: 'EUR Banking Application',
        subtitle: 'Payset IBAN Account',
        disclaimer: 'I confirm that the information provided is accurate and complete. I understand that Tony Durante LLC will use this data to apply for a EUR IBAN account with Payset on behalf of my company.',
        successMessage: 'Your information has been received. We will schedule a live session to complete the Payset IBAN application together.',
        monthlyVolumeLabel: 'Expected Monthly Volume (EUR)',
      },
      it: {
        title: 'Richiesta Conto EUR',
        subtitle: 'Conto IBAN Payset',
        disclaimer: 'Confermo che le informazioni fornite sono accurate e complete. Comprendo che Tony Durante LLC utilizzerà questi dati per richiedere un conto IBAN EUR con Payset per conto della mia azienda.',
        successMessage: 'Le tue informazioni sono state ricevute. Pianificheremo una sessione dal vivo per completare insieme la richiesta IBAN Payset.',
        monthlyVolumeLabel: 'Volume Mensile Previsto (EUR)',
      },
    },
  },
  relay: {
    id: 'relay',
    currency: 'USD',
    labels: {
      en: {
        title: 'USD Banking Application',
        subtitle: 'Relay Business Account',
        disclaimer: 'I confirm that the information provided is accurate and complete. I understand that Tony Durante LLC will use this data to apply for a USD business account with Relay on behalf of my company.',
        successMessage: 'Your information has been received. We will guide you through the Relay account setup process.',
        monthlyVolumeLabel: 'Expected Monthly Volume (USD)',
      },
      it: {
        title: 'Richiesta Conto USD',
        subtitle: 'Conto Business Relay',
        disclaimer: 'Confermo che le informazioni fornite sono accurate e complete. Comprendo che Tony Durante LLC utilizzerà questi dati per richiedere un conto business USD con Relay per conto della mia azienda.',
        successMessage: 'Le tue informazioni sono state ricevute. Ti guideremo nel processo di apertura del conto Relay.',
        monthlyVolumeLabel: 'Volume Mensile Previsto (USD)',
      },
    },
  },
}

export function getProvider(id: string | null | undefined): ProviderConfig {
  if (id && id in PROVIDERS) return PROVIDERS[id as BankingProvider]
  return PROVIDERS.payset // default
}

// ─── DB Record ──────────────────────────────────────────────

export interface BankingSubmission {
  id: string
  token: string
  account_id: string | null
  contact_id: string | null
  provider: BankingProvider
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
  step: 1 | 2
  /** CRM field to pre-fill from. Format: "contacts.column" or "accounts.column" */
  prefillFrom?: string
  options?: string[]
}

// ─── Step Labels ────────────────────────────────────────────

export const STEPS = {
  en: ['Personal Information', 'Business Information & Documents'],
  it: ['Informazioni Personali', 'Informazioni Aziendali e Documenti'],
} as const

// ─── Field Definitions ──────────────────────────────────────

export const FORM_FIELDS: FieldConfig[] = [
  // ═══════════════════════════════════════
  // STEP 1: Personal Information
  // ═══════════════════════════════════════
  { key: 'first_name', type: 'text', required: true, step: 1, prefillFrom: 'contacts.first_name' },
  { key: 'last_name', type: 'text', required: true, step: 1, prefillFrom: 'contacts.last_name' },
  { key: 'personal_street', type: 'text', required: true, step: 1 },
  { key: 'personal_city', type: 'text', required: true, step: 1 },
  { key: 'personal_state_province', type: 'text', required: true, step: 1 },
  { key: 'personal_zip', type: 'text', required: true, step: 1 },
  { key: 'personal_country', type: 'country', required: true, step: 1, prefillFrom: 'contacts.citizenship' },

  // ═══════════════════════════════════════
  // STEP 2: Business Information & Documents
  // ═══════════════════════════════════════
  { key: 'business_name', type: 'text', required: true, step: 2, prefillFrom: 'accounts.company_name' },
  { key: 'business_street', type: 'text', required: true, step: 2 },
  { key: 'business_city', type: 'text', required: true, step: 2 },
  { key: 'business_state_province', type: 'text', required: true, step: 2 },
  { key: 'business_zip', type: 'text', required: true, step: 2 },
  { key: 'business_country', type: 'country', required: true, step: 2 },
  { key: 'business_type', type: 'select', required: true, step: 2, options: ['Retail', 'Manufacturing', 'Services', 'Technology', 'Marketing', 'Agency', 'E-Commerce', 'Business Consulting', 'Finance'] },
  { key: 'us_physical_presence', type: 'select', required: true, step: 2, options: ['Yes', 'No'] },
  { key: 'business_model', type: 'select', required: true, step: 2, options: ['B2B', 'B2C', 'C2B'] },
  { key: 'products_services', type: 'textarea', required: true, step: 2 },
  { key: 'operating_countries', type: 'text', required: true, step: 2 },
  { key: 'website_url', type: 'text', required: false, step: 2 },
  { key: 'phone', type: 'phone', required: true, step: 2, prefillFrom: 'contacts.phone' },
  { key: 'email', type: 'email', required: true, step: 2, prefillFrom: 'contacts.email' },
  { key: 'crypto_transactions', type: 'select', required: true, step: 2, options: ['Yes', 'No'] },
  { key: 'monthly_volume', type: 'number', required: true, step: 2 },
]

// ─── Get fields for a specific step ─────────────────────────

export function getFieldsForStep(step: number): FieldConfig[] {
  return FORM_FIELDS.filter(f => f.step === step)
}

// ─── Bilingual Labels ───────────────────────────────────────

export const LABELS = {
  en: {
    // Page chrome
    title: 'Banking Application',
    subtitle: 'Business Account',
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
    emailGateMessage: 'Enter the email address associated with this application to access it.',
    emailGateButton: 'Access Application',
    emailGateError: 'The email does not match our records. Please try again.',
    emailPlaceholder: 'your@email.com',

    // Step 1: Personal Information
    step1Title: 'Personal Information',
    first_name: 'First Name',
    last_name: 'Last Name',
    personal_street: 'Street Address',
    personal_city: 'City',
    personal_state_province: 'State / Province',
    personal_zip: 'ZIP / Postal Code',
    personal_country: 'Country of Residence',

    // Step 2: Business Information & Documents
    step2Title: 'Business Information & Documents',
    business_name: 'Business Name (LLC)',
    business_street: 'Business Street Address',
    business_city: 'Business City',
    business_state_province: 'Business State / Province',
    business_zip: 'Business ZIP / Postal Code',
    business_country: 'Business Country',
    business_type: 'Business Type',
    us_physical_presence: 'US Physical Presence',
    business_model: 'Business Model',
    products_services: 'Products / Services',
    operating_countries: 'Operating Countries',
    website_url: 'Website URL',
    phone: 'Phone Number',
    email: 'Email Address',
    crypto_transactions: 'Cryptocurrency Transactions',
    monthly_volume: 'Expected Monthly Volume',

    // Uploads
    proof_of_address: 'Proof of Address (utility bill or bank statement)',
    business_bank_statement: 'Business Bank Statement (last 3 months)',
    uploadFile: 'Upload File',
    uploadRequired: 'Required',

    // Disclaimer
    disclaimer: 'I confirm that the information provided is accurate and complete.',
    disclaimerRequired: 'You must accept the disclaimer to submit',

    // Success
    successTitle: 'Form Submitted Successfully!',
    successMessage: 'Your information has been received.',
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
    title: 'Richiesta Conto',
    subtitle: 'Conto Business',
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
    emailGateMessage: 'Inserisci l\'indirizzo email associato a questa richiesta per accedervi.',
    emailGateButton: 'Accedi alla Richiesta',
    emailGateError: 'L\'email non corrisponde ai nostri dati. Riprova.',
    emailPlaceholder: 'tua@email.com',

    // Step 1: Informazioni Personali
    step1Title: 'Informazioni Personali',
    first_name: 'Nome',
    last_name: 'Cognome',
    personal_street: 'Indirizzo',
    personal_city: 'Città',
    personal_state_province: 'Stato / Provincia',
    personal_zip: 'CAP / Codice Postale',
    personal_country: 'Paese di Residenza',

    // Step 2: Informazioni Aziendali e Documenti
    step2Title: 'Informazioni Aziendali e Documenti',
    business_name: 'Nome Azienda (LLC)',
    business_street: 'Indirizzo Aziendale',
    business_city: 'Città Aziendale',
    business_state_province: 'Stato / Provincia Aziendale',
    business_zip: 'CAP Aziendale',
    business_country: 'Paese Aziendale',
    business_type: 'Tipo di Attività',
    us_physical_presence: 'Presenza Fisica negli USA',
    business_model: 'Modello di Business',
    products_services: 'Prodotti / Servizi',
    operating_countries: 'Paesi Operativi',
    website_url: 'Sito Web',
    phone: 'Telefono',
    email: 'Email',
    crypto_transactions: 'Transazioni in Criptovaluta',
    monthly_volume: 'Volume Mensile Previsto',

    // Uploads
    proof_of_address: 'Prova di Residenza (bolletta o estratto conto)',
    business_bank_statement: 'Estratto Conto Aziendale (ultimi 3 mesi)',
    uploadFile: 'Carica File',
    uploadRequired: 'Obbligatorio',

    // Disclaimer
    disclaimer: 'Confermo che le informazioni fornite sono accurate e complete.',
    disclaimerRequired: 'Devi accettare la dichiarazione per inviare',

    // Success
    successTitle: 'Modulo Inviato con Successo!',
    successMessage: 'Le tue informazioni sono state ricevute.',
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
  first_name: {
    en: 'Your legal first name as on your passport.',
    it: 'Il tuo nome legale come appare sul passaporto.',
  },
  last_name: {
    en: 'Your legal last name as on your passport.',
    it: 'Il tuo cognome legale come appare sul passaporto.',
  },
  personal_street: {
    en: 'Your current residential address. This must match your proof of address document.',
    it: 'Il tuo indirizzo di residenza attuale. Deve corrispondere al documento di prova di residenza.',
  },
  personal_country: {
    en: 'Your country of residence.',
    it: 'Il tuo paese di residenza.',
  },
  business_name: {
    en: 'The registered name of your US LLC.',
    it: 'Il nome registrato della tua LLC americana.',
  },
  business_type: {
    en: 'Select the category that best describes your business activity.',
    it: 'Seleziona la categoria che meglio descrive la tua attività aziendale.',
  },
  us_physical_presence: {
    en: 'Do you have a physical office or location in the United States?',
    it: 'Hai un ufficio fisico o una sede negli Stati Uniti?',
  },
  business_model: {
    en: 'B2B = Business to Business, B2C = Business to Consumer, C2B = Consumer to Business.',
    it: 'B2B = Business to Business, B2C = Business to Consumer, C2B = Consumer to Business.',
  },
  products_services: {
    en: 'List the main products or services your company offers.',
    it: 'Elenca i principali prodotti o servizi offerti dalla tua azienda.',
  },
  operating_countries: {
    en: 'List all countries where your company operates or sells to.',
    it: 'Elenca tutti i paesi in cui la tua azienda opera o vende.',
  },
  crypto_transactions: {
    en: 'Does your business involve any cryptocurrency transactions?',
    it: 'La tua attività prevede transazioni in criptovaluta?',
  },
  monthly_volume: {
    en: 'Expected monthly transaction volume through this account.',
    it: 'Volume mensile previsto di transazioni attraverso questo conto.',
  },
  proof_of_address: {
    en: 'Upload a utility bill or personal bank statement not older than 3 months.',
    it: 'Carica una bolletta o estratto conto personale non più vecchio di 3 mesi.',
  },
  business_bank_statement: {
    en: 'Upload your company\'s bank statement for the last 3 months.',
    it: 'Carica l\'estratto conto della tua azienda degli ultimi 3 mesi.',
  },
}
