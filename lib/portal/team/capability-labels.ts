/**
 * Team Powers — the words for every tick, in ONE place.
 *
 * The owner's Team screen, the responsibility notice the owner accepts and the emails to the other owners all list the
 * same powers; they read these labels so they can never drift apart. English and Italian (the owner's language).
 * A test keeps this list identical to TEAM_CAPABILITIES and its "needs" rules identical to normalizeCapabilities.
 *
 * Pure and client-safe.
 */
import { TEAM_CAPABILITIES, type CapabilityFlags, type TeamCapability } from './capabilities'

export type NoticeLang = 'en' | 'it'

export type CapabilityGroupKey = 'look' | 'talk' | 'money' | 'forms'

export interface CapabilityLabel {
  key: TeamCapability
  group: CapabilityGroupKey
  /** The tick this one hangs under (it stays grey until that tick is on). */
  parent?: TeamCapability
  en: { label: string; hint: string }
  it: { label: string; hint: string }
}

export const CAPABILITY_GROUPS: { key: CapabilityGroupKey; en: string; it: string }[] = [
  { key: 'look', en: 'Look at things', it: 'Consultare' },
  { key: 'talk', en: 'Talk to us', it: 'Parlare con noi' },
  { key: 'money', en: 'Money', it: 'Denaro' },
  { key: 'forms', en: 'Forms for the company', it: 'Moduli della società' },
]

/** In the order the owner sees them: a tick is followed by the options that hang under it. */
export const CAPABILITY_LABELS: CapabilityLabel[] = [
  {
    key: 'documents', group: 'look',
    en: { label: 'Documents', hint: "See the company's documents, including legal ones. They cannot sign them." },
    it: { label: 'Documenti', hint: 'Vedere i documenti della società, anche quelli legali. Non possono firmarli.' },
  },
  {
    key: 'answer_decisions', group: 'look', parent: 'documents',
    en: { label: 'Can answer client decisions', hint: 'Approve or choose when we ask the company a question.' },
    it: { label: 'Può rispondere alle decisioni', hint: 'Approvare o scegliere quando facciamo una domanda alla società.' },
  },
  {
    key: 'company_services', group: 'look',
    en: { label: 'Company & Services', hint: 'See the company profile, its services and deadlines, and change the company logo.' },
    it: { label: 'Società e servizi', hint: 'Vedere il profilo della società, i servizi e le scadenze, e cambiare il logo della società.' },
  },
  {
    key: 'announcements', group: 'look',
    en: { label: 'Announcements', hint: 'See our announcements to the company.' },
    it: { label: 'Annunci', hint: 'Vedere i nostri annunci alla società.' },
  },
  {
    key: 'sales_customers', group: 'look',
    en: { label: 'Sales customers', hint: "See and use the company's own list of customers." },
    it: { label: 'Clienti della società', hint: "Vedere e usare l'elenco dei clienti della società." },
  },
  {
    key: 'chat', group: 'talk',
    en: { label: 'Chat', hint: 'Write to us in the company chat, under their own name.' },
    it: { label: 'Chat', hint: 'Scriverci nella chat della società, con il proprio nome.' },
  },
  {
    key: 'request_services', group: 'talk', parent: 'chat',
    en: { label: 'Can ask for new services', hint: 'Send us a service request.' },
    it: { label: 'Può chiedere nuovi servizi', hint: 'Inviarci una richiesta di servizio.' },
  },
  {
    key: 'invoices_billing', group: 'money',
    en: { label: 'Invoices & Billing', hint: "See the company's invoices and ours, pay our invoices, set up automatic card payments." },
    it: { label: 'Fatture e pagamenti', hint: 'Vedere le fatture della società e le nostre, pagare le nostre fatture, attivare i pagamenti automatici con carta.' },
  },
  {
    key: 'payment_links', group: 'money', parent: 'invoices_billing',
    en: { label: 'Can change payment links', hint: 'Add, remove or change the links customers use to pay. Off means they can only see them.' },
    it: { label: 'Può cambiare i link di pagamento', hint: 'Aggiungere, togliere o cambiare i link che i clienti usano per pagare. Se spento, può solo vederli.' },
  },
  {
    key: 'invoice_history', group: 'money', parent: 'invoices_billing',
    en: { label: 'Can see invoices and expenses from before they joined', hint: 'Off means they see only what is saved from the day you add them.' },
    it: { label: 'Può vedere fatture e spese di prima del suo ingresso', hint: 'Se spento, vede solo ciò che è salvato dal giorno in cui viene aggiunto.' },
  },
  {
    key: 'bank_applications', group: 'forms',
    // The LABEL is what the owner's notice lists ("describeCapabilities"), so the bank accounts are named in it too — not only in the hint on the screen.
    en: { label: 'Bank applications & bank accounts', hint: "Fill in and send the bank application (Payset or Relay), and add, change or remove the company's bank accounts, including which one is printed on its invoices." },
    it: { label: 'Richieste bancarie e conti bancari', hint: 'Compilare e inviare la richiesta bancaria (Payset o Relay), e aggiungere, modificare o togliere i conti bancari della società, compreso quello che compare sulle sue fatture.' },
  },
  {
    key: 'company_data_form', group: 'forms',
    en: { label: 'Company data form', hint: 'Fill in the company data form we ask for when a company is set up.' },
    it: { label: 'Modulo dati societari', hint: "Compilare il modulo dati societari che chiediamo all'avvio della società." },
  },
  {
    key: 'company_forms', group: 'forms',
    en: { label: 'Company forms (tax questionnaire)', hint: "Fill in and send the company's tax questionnaire. Signing the tax return always stays with you." },
    it: { label: 'Moduli societari (questionario fiscale)', hint: 'Compilare e inviare il questionario fiscale della società. La firma della dichiarazione resta sempre a te.' },
  },
]

const BY_KEY = new Map(CAPABILITY_LABELS.map((c) => [c.key, c]))

export function capabilityLabel(key: string, lang: NoticeLang = 'en'): string {
  const c = BY_KEY.get(key as TeamCapability)
  return c ? c[lang].label : key
}

/** The labels of the powers that are ON, in the order the owner sees them. */
export function describeCapabilities(caps: CapabilityFlags | Record<string, boolean> | null | undefined, lang: NoticeLang = 'en'): string[] {
  const on = caps ?? {}
  return CAPABILITY_LABELS.filter((c) => (on as Record<string, boolean>)[c.key] === true).map((c) => c[lang].label)
}

/** Every key the screen can show must exist in the real list (a test enforces both directions). */
export const LABELLED_KEYS: TeamCapability[] = CAPABILITY_LABELS.map((c) => c.key)
export const ALL_KEYS: readonly TeamCapability[] = TEAM_CAPABILITIES
