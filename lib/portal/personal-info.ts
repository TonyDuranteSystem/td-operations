/**
 * Personal details shown on the portal home page (Panoramica) — Antonio, 2026-11-05.
 *
 * The "Informazioni Personali" card (same form and same save as the Profilo page) and the
 * read-only "Identità e Tasse" card (passport + ITIN) now live on Panoramica, because the Profilo
 * entry left the menu. This file holds the two pieces that are not markup:
 *   - `getPersonalInfo(contactId)`: ONE read of the contact with an explicit column list (never `*`).
 *   - `buildIdentityCard(contact)`: pure — decides which identity blocks exist, so a client with no passport
 *     details and no ITIN gets no card at all (same rule the Profilo ITIN block always had).
 *
 * Passport and ITIN are READ-ONLY here. The team maintains them (the ITIN is stamped by the ITIN-approval
 * finalize; the passport by the document pipeline), so the client cannot edit them from this card.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export interface PersonalEditorData {
  first_name: string
  last_name: string
  email: string
  phone: string
  language: string
  citizenship: string
  address_line1: string
  address_city: string
  address_state: string
  address_zip: string
  address_country: string
}

export interface PassportBlock {
  /** The passport document is on file with us. */
  onFile: boolean
  number: string | null
  /** ISO date (YYYY-MM-DD). */
  expiry: string | null
}

export interface ItinBlock {
  number: string
  issueDate: string | null
  renewalDate: string | null
}

export interface IdentityCardData {
  passport: PassportBlock | null
  itin: ItinBlock | null
}

export interface PersonalInfoData {
  contactId: string
  editor: PersonalEditorData
  identity: IdentityCardData | null
}

/** The columns read from `contacts` — kept explicit so a new sensitive column is never shown by accident. */
export const PERSONAL_INFO_COLUMNS =
  'first_name, last_name, email, phone, language, citizenship, address_line1, address_city, address_state, address_zip, address_country, passport_number, passport_expiry_date, passport_on_file, itin_number, itin_issue_date, itin_renewal_date'

export interface PersonalInfoContactRow {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  language?: string | null
  citizenship?: string | null
  address_line1?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  address_country?: string | null
  passport_number?: string | null
  passport_expiry_date?: string | null
  passport_on_file?: boolean | null
  itin_number?: string | null
  itin_issue_date?: string | null
  itin_renewal_date?: string | null
}

const clean = (v: string | null | undefined): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

/** Same shape the Profilo page hands to the editor: every field a string, never null. */
export function buildEditorData(c: PersonalInfoContactRow | null | undefined): PersonalEditorData {
  return {
    first_name: c?.first_name ?? '',
    last_name: c?.last_name ?? '',
    email: c?.email ?? '',
    phone: c?.phone ?? '',
    language: c?.language ?? '',
    citizenship: c?.citizenship ?? '',
    address_line1: c?.address_line1 ?? '',
    address_city: c?.address_city ?? '',
    address_state: c?.address_state ?? '',
    address_zip: c?.address_zip ?? '',
    address_country: c?.address_country ?? '',
  }
}

/**
 * Which identity blocks this person has. The passport block shows when there is a passport number, an expiry
 * date, or the document is on file; the ITIN block shows when there is an ITIN number (the rule the Profilo page
 * has always used). Neither → null → no card.
 */
export function buildIdentityCard(c: PersonalInfoContactRow | null | undefined): IdentityCardData | null {
  if (!c) return null
  const passportNumber = clean(c.passport_number)
  const passportExpiry = clean(c.passport_expiry_date)
  const onFile = c.passport_on_file === true
  const passport: PassportBlock | null =
    passportNumber || passportExpiry || onFile ? { onFile, number: passportNumber, expiry: passportExpiry } : null

  const itinNumber = clean(c.itin_number)
  const itin: ItinBlock | null = itinNumber
    ? { number: itinNumber, issueDate: clean(c.itin_issue_date), renewalDate: clean(c.itin_renewal_date) }
    : null

  return passport || itin ? { passport, itin } : null
}

/**
 * A calendar date (YYYY-MM-DD) for display, in the client's language. Parsed as a plain date — never through the
 * viewer's timezone, which would show the day before for anyone west of UTC. Anything that is not a date comes
 * back unchanged so a odd stored value is shown rather than hidden.
 */
export function formatPersonalDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(d)
  } catch {
    return iso
  }
}

/** Server-side: the data for the two cards, or null when there is no contact (a team member has none). */
export async function getPersonalInfo(contactId: string | null | undefined): Promise<PersonalInfoData | null> {
  if (!contactId) return null
  const { data } = await supabaseAdmin.from('contacts').select(PERSONAL_INFO_COLUMNS).eq('id', contactId).maybeSingle()
  if (!data) return null
  const row = data as unknown as PersonalInfoContactRow
  return { contactId, editor: buildEditorData(row), identity: buildIdentityCard(row) }
}
