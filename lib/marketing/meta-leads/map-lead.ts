/**
 * Turns what the Meta Graph API returns for ONE lead into our columns (pure; TD Marketing, dev job 9aec66fa).
 * Graph returns: { id, created_time, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, form_id, is_organic, platform,
 * field_data: [{ name, values: [..] }] }. EVERY answer is kept in `answers` exactly as received (a form field renamed in Meta is stored
 * raw, never dropped); the convenience columns (name, email, phone ...) are only extracted from the well-known standard field names.
 */
export interface GraphLead {
  id: string
  created_time?: string
  ad_id?: string
  ad_name?: string
  adset_id?: string
  adset_name?: string
  campaign_id?: string
  campaign_name?: string
  form_id?: string
  is_organic?: boolean
  platform?: string
  field_data?: Array<{ name?: string; values?: unknown[] }>
}

export interface LeadAnswer { name: string; values: string[] }

export interface MappedLead {
  leadgenId: string
  fullName: string | null
  email: string | null
  phone: string | null
  country: string | null
  city: string | null
  answers: LeadAnswer[]
  adId: string | null
  adName: string | null
  adsetId: string | null
  adsetName: string | null
  campaignId: string | null
  campaignName: string | null
  formId: string | null
  platform: string | null
  isOrganic: boolean | null
  metaCreatedTime: string | null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.trim().toLowerCase()
  return s.length <= 254 && EMAIL.test(s) ? s : null
}

/** Keeps a leading + and digits; returns null when fewer than 6 digits remain (not a usable number). */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string") return null
  const trimmed = v.trim()
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length < 6 || digits.length > 18) return null
  return (trimmed.startsWith("+") || trimmed.startsWith("00") ? "+" : "") + (trimmed.startsWith("00") ? digits.slice(2) : digits)
}

function clean(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim()
  return s ? s.slice(0, max) : null
}

/** A form field's name made comparable: lower case, accents removed, every run of other characters becomes one underscore ("E-mail", "e_mail" and "e-mail" are the same field). */
export function fieldKey(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

function firstValue(answers: LeadAnswer[], names: string[]): string | null {
  for (const n of names) {
    const a = answers.find(x => fieldKey(x.name) === n)
    if (a && a.values[0]) return a.values[0]
  }
  return null
}

// The form's own field names, English (Meta's standard ones) and Italian (Antonio's forms: "nome_e_cognome", "e-mail", "numero_di_telefono").
const FULL_NAME = ["full_name", "name", "nome_e_cognome", "nome_cognome", "nome_completo", "cognome_e_nome"]
const FIRST_NAME = ["first_name", "nome"]
const LAST_NAME = ["last_name", "cognome"]
const EMAIL_FIELDS = ["email", "e_mail", "work_email", "email_address", "indirizzo_email", "indirizzo_e_mail"]
const PHONE_FIELDS = ["phone_number", "phone", "work_phone_number", "numero_di_telefono", "numero_telefono", "telefono", "numero_di_cellulare", "cellulare", "mobile"]
const COUNTRY_FIELDS = ["country", "paese", "nazione"]
const CITY_FIELDS = ["city", "citta"]
const MARK_TEST = /^<test lead/i

export interface Contact { fullName: string | null; email: string | null; phone: string | null; country: string | null; city: string | null }

/**
 * The person's name, email and phone out of the form answers. Meta's own "Test lead" button fills every field with "<test lead: dummy data for ...>":
 * such a lead is named "Meta test lead" (so nobody calls it) and its dummy email and phone are not kept.
 */
export function extractContact(answers: LeadAnswer[]): Contact {
  const first = firstValue(answers, FIRST_NAME)
  const last = firstValue(answers, LAST_NAME)
  let full = firstValue(answers, FULL_NAME) ?? ([first, last].filter(Boolean).join(" ") || null)
  if (full && MARK_TEST.test(full.trim())) full = "Meta test lead"
  const keep = (v: string | null) => (v && MARK_TEST.test(v.trim()) ? null : v)
  return {
    fullName: clean(full, 200),
    email: normalizeEmail(keep(firstValue(answers, EMAIL_FIELDS))),
    phone: normalizePhone(keep(firstValue(answers, PHONE_FIELDS))),
    country: clean(keep(firstValue(answers, COUNTRY_FIELDS)), 100),
    city: clean(keep(firstValue(answers, CITY_FIELDS)), 100),
  }
}

export function mapGraphLead(g: GraphLead): MappedLead {
  const answers: LeadAnswer[] = (Array.isArray(g.field_data) ? g.field_data : [])
    .map(f => ({
      name: clean(f?.name, 200) ?? "",
      values: (Array.isArray(f?.values) ? f.values : []).map(v => clean(String(v ?? ""), 2000)).filter((x): x is string => !!x),
    }))
    .filter(a => a.name)
  const c = extractContact(answers)
  return {
    leadgenId: String(g.id),
    fullName: c.fullName,
    email: c.email,
    phone: c.phone,
    country: c.country,
    city: c.city,
    answers,
    adId: clean(g.ad_id, 40), adName: clean(g.ad_name, 300),
    adsetId: clean(g.adset_id, 40), adsetName: clean(g.adset_name, 300),
    campaignId: clean(g.campaign_id, 40), campaignName: clean(g.campaign_name, 300),
    formId: clean(g.form_id, 40),
    platform: clean(g.platform, 30),
    isOrganic: typeof g.is_organic === "boolean" ? g.is_organic : null,
    metaCreatedTime: g.created_time && !Number.isNaN(Date.parse(g.created_time)) ? new Date(g.created_time).toISOString() : null,
  }
}
