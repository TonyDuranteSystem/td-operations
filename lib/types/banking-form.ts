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
  step: 1 | 2 | 3
  /** CRM field to pre-fill from. Format: "contacts.column" or "accounts.column" */
  prefillFrom?: string
  options?: string[]
}

// ─── Upload Config ──────────────────────────────────────────

export interface UploadConfig {
  key: string
  required: boolean
  accept: string
}

export const PAYSET_UPLOADS: UploadConfig[] = [
  { key: 'proof_of_address', required: true, accept: '.pdf,.jpg,.jpeg,.png' },
  { key: 'business_bank_statement', required: true, accept: '.pdf,.jpg,.jpeg,.png' },
]

export const RELAY_UPLOADS: UploadConfig[] = [
  { key: 'passport_image', required: true, accept: '.jpg,.jpeg,.png' },
  { key: 'proof_of_address', required: true, accept: '.pdf,.jpg,.jpeg,.png' },
]

export function getUploads(provider: BankingProvider): UploadConfig[] {
  return provider === 'relay' ? RELAY_UPLOADS : PAYSET_UPLOADS
}

// ─── Step Labels ────────────────────────────────────────────

export const STEPS: Record<BankingProvider, { en: string[]; it: string[] }> = {
  payset: {
    en: ['Personal Information', 'Business Information & Documents'],
    it: ['Informazioni Personali', 'Informazioni Aziendali e Documenti'],
  },
  relay: {
    en: ['Business Information', 'Owner Information & Documents', 'Partner Information'],
    it: ['Informazioni Aziendali', 'Informazioni Titolare e Documenti', 'Informazioni Socio'],
  },
}

// ─── Field Definitions — Payset (EUR IBAN) ──────────────────

export const PAYSET_FIELDS: FieldConfig[] = [
  // Step 1: Personal Information
  { key: 'first_name', type: 'text', required: true, step: 1, prefillFrom: 'contacts.first_name' },
  { key: 'last_name', type: 'text', required: true, step: 1, prefillFrom: 'contacts.last_name' },
  { key: 'personal_street', type: 'text', required: true, step: 1 },
  { key: 'personal_city', type: 'text', required: true, step: 1 },
  { key: 'personal_state_province', type: 'text', required: true, step: 1 },
  { key: 'personal_zip', type: 'text', required: true, step: 1 },
  { key: 'personal_country', type: 'country', required: true, step: 1, prefillFrom: 'contacts.citizenship' },

  // Step 2: Business Information & Documents
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

// ─── Field Definitions — Relay (USD Business Account) ───────

export const RELAY_FIELDS: FieldConfig[] = [
  // Step 1: Business Information
  { key: 'business_name', type: 'text', required: true, step: 1, prefillFrom: 'accounts.company_name' },
  { key: 'phone', type: 'phone', required: true, step: 1, prefillFrom: 'contacts.phone' },
  { key: 'email', type: 'email', required: true, step: 1, prefillFrom: 'contacts.email' },
  { key: 'ein', type: 'text', required: true, step: 1, prefillFrom: 'accounts.ein' },
  { key: 'business_description', type: 'textarea', required: true, step: 1 },
  { key: 'avg_monthly_revenue', type: 'number', required: true, step: 1 },
  { key: 'other_us_bank', type: 'text', required: false, step: 1 },

  // Step 2: Owner Information & Documents
  { key: 'last_name', type: 'text', required: true, step: 2, prefillFrom: 'contacts.last_name' },
  { key: 'first_name', type: 'text', required: true, step: 2, prefillFrom: 'contacts.first_name' },
  { key: 'personal_street', type: 'text', required: true, step: 2 },
  { key: 'personal_city', type: 'text', required: true, step: 2 },
  { key: 'personal_state', type: 'text', required: true, step: 2 },
  { key: 'personal_zip', type: 'text', required: true, step: 2 },
  { key: 'personal_phone', type: 'phone', required: true, step: 2, prefillFrom: 'contacts.phone' },
  { key: 'equity_pct', type: 'number', required: true, step: 2 },
  { key: 'personal_email', type: 'email', required: true, step: 2, prefillFrom: 'contacts.email' },
  { key: 'has_partner', type: 'select', required: true, step: 2, options: ['No', 'Yes'] },

  // Step 3: Partner Information (only shown if has_partner = 'Yes')
  { key: 'partner_last_name', type: 'text', required: true, step: 3 },
  { key: 'partner_first_name', type: 'text', required: true, step: 3 },
  { key: 'partner_street', type: 'text', required: true, step: 3 },
  { key: 'partner_city', type: 'text', required: true, step: 3 },
  { key: 'partner_state', type: 'text', required: true, step: 3 },
  { key: 'partner_zip', type: 'text', required: true, step: 3 },
  { key: 'partner_phone', type: 'phone', required: true, step: 3 },
  { key: 'partner_equity_pct', type: 'number', required: true, step: 3 },
  { key: 'partner_email', type: 'email', required: true, step: 3 },
]

// ─── Backward compat + provider-aware helpers ───────────────

/** @deprecated Use getFormFields(provider, step) instead */
export const FORM_FIELDS = PAYSET_FIELDS

export function getFormFields(provider: BankingProvider): FieldConfig[] {
  return provider === 'relay' ? RELAY_FIELDS : PAYSET_FIELDS
}

export function getFieldsForStep(step: number, provider: BankingProvider = 'payset'): FieldConfig[] {
  return getFormFields(provider).filter(f => f.step === step)
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

    // Prefill disclaimer
    prefillDisclaimer: 'Some fields have been pre-filled with your information on file. Please verify that all pre-filled data is correct before submitting.',

    // Shared field labels
    first_name: 'First Name',
    last_name: 'Last Name',
    personal_street: 'Street Address',
    personal_city: 'City',
    personal_state_province: 'State / Province',
    personal_state: 'State / Province',
    personal_zip: 'ZIP / Postal Code',
    personal_country: 'Country of Residence',
    business_name: 'Business Name (LLC)',
    business_street: 'Business Street Address',
    business_city: 'Business City',
    business_state_province: 'Business State / Province',
    business_state: 'State',
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

    // Relay-specific field labels
    ein: 'EIN Number',
    entity_type: 'Entity Type',
    mailing_address: 'Mailing Address',
    avg_monthly_revenue: 'Average Monthly Revenue (USD)',
    other_us_bank: 'Other US Bank Account',
    business_description: 'Business Description',
    personal_phone: 'Personal Phone',
    equity_pct: 'Equity %',
    personal_email: 'Personal Email',
    has_partner: 'Do you have a business partner?',
    partner_last_name: 'Partner Last Name',
    partner_first_name: 'Partner First Name',
    partner_street: 'Partner Street Address',
    partner_city: 'Partner City',
    partner_state: 'Partner State / Province',
    partner_zip: 'Partner ZIP / Postal Code',
    partner_phone: 'Partner Phone',
    partner_equity_pct: 'Partner Equity %',
    partner_email: 'Partner Email',

    // Step titles (provider-specific)
    step1Title: 'Personal Information',
    step2Title: 'Business Information & Documents',
    relayStep1Title: 'Business Information',
    relayStep2Title: 'Owner Information & Documents',
    relayStep3Title: 'Partner Information',

    // Uploads — Payset
    proof_of_address: 'Proof of Address (utility bill or bank statement)',
    business_bank_statement: 'Business Bank Statement (last 3 months)',
    // Uploads — Relay
    passport_image: 'Passport Photo (JPG format, all 4 corners visible, no fingers)',
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

    // Prefill disclaimer
    prefillDisclaimer: 'Alcuni campi sono stati precompilati con i dati in nostro possesso. Si prega di verificare che tutte le informazioni precompilate siano corrette prima di inviare.',

    // Shared field labels
    first_name: 'Nome',
    last_name: 'Cognome',
    personal_street: 'Indirizzo',
    personal_city: 'Città',
    personal_state_province: 'Stato / Provincia',
    personal_state: 'Stato / Provincia',
    personal_zip: 'CAP / Codice Postale',
    personal_country: 'Paese di Residenza',
    business_name: 'Nome Azienda (LLC)',
    business_street: 'Indirizzo Aziendale',
    business_city: 'Città Aziendale',
    business_state_province: 'Stato / Provincia Aziendale',
    business_state: 'Stato',
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

    // Relay-specific field labels
    ein: 'Numero EIN',
    entity_type: 'Tipo di Entità',
    mailing_address: 'Indirizzo Postale',
    avg_monthly_revenue: 'Fatturato Mensile Medio (USD)',
    other_us_bank: 'Altro Conto Bancario USA',
    business_description: 'Descrizione Attività',
    personal_phone: 'Telefono Personale',
    equity_pct: 'Quota Societaria %',
    personal_email: 'Email Personale',
    has_partner: 'Hai un socio?',
    partner_last_name: 'Cognome Socio',
    partner_first_name: 'Nome Socio',
    partner_street: 'Indirizzo Socio',
    partner_city: 'Città Socio',
    partner_state: 'Stato / Provincia Socio',
    partner_zip: 'CAP Socio',
    partner_phone: 'Telefono Socio',
    partner_equity_pct: 'Quota Societaria Socio %',
    partner_email: 'Email Socio',

    // Step titles (provider-specific)
    step1Title: 'Informazioni Personali',
    step2Title: 'Informazioni Aziendali e Documenti',
    relayStep1Title: 'Informazioni Aziendali',
    relayStep2Title: 'Informazioni Titolare e Documenti',
    relayStep3Title: 'Informazioni Socio',

    // Uploads — Payset
    proof_of_address: 'Prova di Residenza (bolletta o estratto conto)',
    business_bank_statement: 'Estratto Conto Aziendale (ultimi 3 mesi)',
    // Uploads — Relay
    passport_image: 'Foto Passaporto (formato JPG, tutti e 4 gli angoli visibili, senza dita)',
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
  // Relay-specific
  ein: {
    en: 'Your Employer Identification Number (EIN) assigned by the IRS.',
    it: 'Il tuo Employer Identification Number (EIN) assegnato dall\'IRS.',
  },
  business_description: {
    en: 'Describe what your business does — products, services, industry. Be as precise and detailed as possible: this is where the bank truly gets to know your business and evaluates what you do.',
    it: 'Descrivi cosa fa la tua azienda — prodotti, servizi, settore. Sii il più preciso e dettagliato possibile: è qui che la banca vi conosce veramente e valuta quello che fate.',
  },
  avg_monthly_revenue: {
    en: 'Estimated average monthly revenue in US dollars.',
    it: 'Fatturato mensile medio stimato in dollari USA.',
  },
  other_us_bank: {
    en: 'If you already have a US bank account, specify the bank name.',
    it: 'Se hai già un conto bancario americano, specifica il nome della banca.',
  },
  personal_phone: {
    en: 'Your personal phone number.',
    it: 'Il tuo numero di telefono personale.',
  },
  equity_pct: {
    en: 'Your ownership percentage in the company (e.g., 100 for sole owner, 50 for equal partners).',
    it: 'La tua percentuale di proprietà nell\'azienda (es. 100 per unico titolare, 50 per soci paritari).',
  },
  personal_email: {
    en: 'Your personal email address.',
    it: 'Il tuo indirizzo email personale.',
  },
  has_partner: {
    en: 'Select "Yes" if your LLC has more than one member/owner.',
    it: 'Seleziona "Sì" se la tua LLC ha più di un membro/titolare.',
  },
  passport_image: {
    en: 'Take a clear photo of your passport in JPG format. All 4 corners must be visible, no fingers covering the document.',
    it: 'Scatta una foto chiara del tuo passaporto in formato JPG. Tutti e 4 gli angoli devono essere visibili, senza dita che coprono il documento.',
  },
  personal_state: {
    en: 'Your state or province of residence.',
    it: 'Il tuo stato o provincia di residenza.',
  },
}
