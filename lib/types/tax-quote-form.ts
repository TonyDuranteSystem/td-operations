/**
 * Tax Quote Form Types — Simple intake form for tax return quotes.
 * Used by: app/tax-quote/[token]/page.tsx, lib/mcp/tools/tax-quote.ts
 */

export type LLCType = "single_member" | "multi_member" | "c_corp"

export interface TaxQuoteSubmission {
  id: string
  token: string
  lead_id: string | null
  offer_token: string | null
  llc_name: string | null
  llc_state: string | null
  llc_type: LLCType | null
  tax_year: number | null
  client_name: string | null
  client_email: string | null
  client_phone: string | null
  language: "en" | "it"
  status: "pending" | "sent" | "opened" | "completed" | "processed"
  sent_at: string | null
  opened_at: string | null
  completed_at: string | null
  processed_at: string | null
  client_ip: string | null
  client_user_agent: string | null
  created_at: string
  updated_at: string
}

export const LLC_TYPE_OPTIONS = [
  { value: "single_member", en: "Single-Member LLC", it: "LLC Singolo Membro" },
  { value: "multi_member", en: "Multi-Member LLC", it: "LLC Multi-Membro" },
  { value: "c_corp", en: "LLC elected as C Corp", it: "LLC con elezione C Corp" },
] as const

export const PRICING: Record<LLCType, number> = {
  single_member: 1000,
  multi_member: 1500,
  c_corp: 1500,
}

export const FORM_DESCRIPTIONS: Record<LLCType, { en: string; it: string }> = {
  single_member: {
    en: "Form 1120 + Form 5472",
    it: "Form 1120 + Form 5472",
  },
  multi_member: {
    en: "Form 1065 + Schedule K-1 per member",
    it: "Form 1065 + Schedule K-1 per socio",
  },
  c_corp: {
    en: "Form 1120 (C Corporation)",
    it: "Form 1120 (C Corporation)",
  },
}

export const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana",
  "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York",
  "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
] as const

export const LABELS = {
  en: {
    title: "Tax Return Quote",
    subtitle: "Get a quote for your LLC tax return filing",
    llc_name: "LLC Name",
    llc_state: "State of Formation",
    llc_type: "LLC Type",
    tax_year: "Tax Year",
    client_name: "Your Full Name",
    client_email: "Email Address",
    client_phone: "Phone Number (optional)",
    submit: "Get My Quote",
    submitting: "Submitting...",
    required: "Required",
    successTitle: "Quote Request Received!",
    successMessage: "We will review your information and send you a personalized proposal shortly.",
    notFound: "Form Not Found",
    notFoundMessage: "This link is not valid or has expired.",
    loading: "Loading...",
    errorSubmit: "An error occurred. Please try again.",
    disclaimer: "I confirm that the information provided is accurate.",
    pricingNote: "Estimated pricing:",
    pricingSingle: "Single-Member LLC: $1,000",
    pricingMulti: "Multi-Member LLC / C Corp: $1,500",
    selectPlaceholder: "Select...",
  },
  it: {
    title: "Preventivo Tax Return",
    subtitle: "Richiedi un preventivo per la dichiarazione fiscale della tua LLC",
    llc_name: "Nome LLC",
    llc_state: "Stato di Formazione",
    llc_type: "Tipo di LLC",
    tax_year: "Anno Fiscale",
    client_name: "Nome e Cognome",
    client_email: "Indirizzo Email",
    client_phone: "Telefono (opzionale)",
    submit: "Richiedi Preventivo",
    submitting: "Invio in corso...",
    required: "Obbligatorio",
    successTitle: "Richiesta Ricevuta!",
    successMessage: "Esamineremo le tue informazioni e ti invieremo una proposta personalizzata a breve.",
    notFound: "Modulo Non Trovato",
    notFoundMessage: "Questo link non è valido o è scaduto.",
    loading: "Caricamento...",
    errorSubmit: "Si è verificato un errore. Riprova.",
    disclaimer: "Confermo che le informazioni fornite sono accurate.",
    pricingNote: "Prezzi indicativi:",
    pricingSingle: "LLC Singolo Membro: $1.000",
    pricingMulti: "LLC Multi-Membro / C Corp: $1.500",
    selectPlaceholder: "Seleziona...",
  },
} as const
