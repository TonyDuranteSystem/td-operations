/**
 * Relay application — the "other owners" step (dev job 2751fb26).
 *
 * The portal Relay bank application used to ask for ONE individual "partner". A company owned by other
 * companies could not be entered at all (Oh My Creatives LLC, 20 Nov 2026: one person at 1% and three
 * companies at 33% each). Step 3 is now a list of every OTHER owner — a person or a company, and for a
 * company its representative — prefilled from the owners list we already hold (the CRM `members` table),
 * so the client checks and confirms instead of typing.
 *
 * Everything here is pure (no database, no clock): the wizard page reads the rows and hands them in.
 * The answers stay on the application only — nothing here writes back to the CRM.
 *
 * Answer keys (flat, same shape as the other member steps): `has_partner` (Yes/No, kept from the old
 * form so older submissions and staff views still read), `member_count`, `member_{i}_<field>`, and
 * `members_confirmed` (the client's tick that the owners shown are correct).
 */

/** One row of the CRM owners list (`members`), only the columns this step reads. */
export interface OwnerRow {
  member_type: string | null
  full_name: string | null
  company_name: string | null
  ein: string | null
  email: string | null
  phone: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
  ownership_pct: number | string | null
  contact_id: string | null
  representative_name: string | null
  representative_email: string | null
  representative_phone: string | null
  representative_address_street: string | null
  representative_address_city: string | null
  representative_address_state: string | null
  representative_address_zip: string | null
  representative_address_country: string | null
  /** YYYY-MM-DD the owner left the company; absent or in the past = no longer an owner */
  end_date?: string | null
}

/** First/last name of a linked contact — more reliable than splitting `full_name`. */
export interface OwnerContactNames {
  first_name: string | null
  last_name: string | null
}

import { WIZARD_COUNTRIES } from '@/lib/portal/wizard-countries'

const isCompany = (r: OwnerRow): boolean => r.member_type === 'company'

/** Lower case, single spaces, accents folded ("José" = "Jose") — for comparing a typed name with the CRM's. */
const norm = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase()

// The CRM spells some countries differently from the wizard's country list ("USA" vs "United States", "Italia" vs "Italy").
// A value that is not in the list shows as "Select country..." even though it is saved, so the prefill uses the list's spelling.
const COUNTRY_ALIASES: Record<string, string> = {
  'usa': 'United States',
  'us': 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  'united states of america': 'United States',
  'stati uniti': 'United States',
  "stati uniti d'america": 'United States',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'regno unito': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'emirati arabi uniti': 'United Arab Emirates',
  'czechia': 'Czech Republic',
  'italia': 'Italy',
  'spagna': 'Spain',
  'francia': 'France',
  'germania': 'Germany',
  'svizzera': 'Switzerland',
  'portogallo': 'Portugal',
  'paesi bassi': 'Netherlands',
  'olanda': 'Netherlands',
  'grecia': 'Greece',
  'polonia': 'Poland',
  'turchia': 'Turkey',
  'cina': 'China',
  'giappone': 'Japan',
  'brasile': 'Brazil',
  'messico': 'Mexico',
}
const COUNTRY_BY_LOWER: Record<string, string> = Object.fromEntries(WIZARD_COUNTRIES.map((c) => [c.toLowerCase(), c]))

/** The wizard list's spelling of a country as the CRM wrote it (any capitals, common aliases, Italian names); anything not recognised is returned as written. */
export function normalizeCountry(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null
  const t = name.trim().replace(/\s+/g, ' ')
  if (t === '') return null
  const k = t.toLowerCase()
  return COUNTRY_BY_LOWER[k] ?? COUNTRY_ALIASES[k] ?? t
}

/** "Ada Lovelace King" → first "Ada", last "Lovelace King". Only used when no contact names exist. */
export function splitFullName(full: string | null | undefined): { first: string; last: string } {
  const t = (full ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return { first: '', last: '' }
  const i = t.indexOf(' ')
  return i < 0 ? { first: t, last: '' } : { first: t.slice(0, i), last: t.slice(i + 1) }
}

/** Owners that still own the company on `today` (YYYY-MM-DD). */
export function currentOwners(rows: OwnerRow[], today: string): OwnerRow[] {
  return rows.filter((r) => !r.end_date || r.end_date > today)
}

/**
 * Which row is the person filling the form? The owner step already asks for their own details and
 * percentage, so their row must not come back as a card. First by contact link; if that link points at
 * a company row (the person is that company's representative) or at nothing, by the same full name on a
 * person row — a real client can hold two contacts (one as owner, one as a company's representative).
 */
export function findSubmitterRow(
  rows: OwnerRow[],
  submitter: { contactId: string | null; fullName: string | null },
): OwnerRow | null {
  const persons = rows.filter((r) => !isCompany(r))
  if (submitter.contactId) {
    const byLink = persons.find((r) => r.contact_id === submitter.contactId)
    if (byLink) return byLink
  }
  const n = norm(submitter.fullName)
  if (n) {
    const byName = persons.filter((r) => norm(r.full_name) === n)
    if (byName.length === 1) return byName[0]
  }
  return null
}

function set(out: Record<string, string>, key: string, value: string | number | null | undefined): void {
  if (value === null || value === undefined) return
  const s = String(value).trim()
  if (s !== '') out[key] = s
}

/**
 * The prefill for the Relay application's owner percentage, "other owners?" answer and one card per
 * other owner. Returns {} when the CRM holds no owners at all (the client then fills it in themselves).
 */
export function buildRelayOwnersPrefill(
  allRows: OwnerRow[],
  submitter: { contactId: string | null; fullName: string | null },
  contactNames: Record<string, OwnerContactNames>,
  today: string,
): Record<string, string> {
  const rows = currentOwners(allRows, today)
  if (rows.length === 0) return {}

  const out: Record<string, string> = {}
  const own = findSubmitterRow(rows, submitter)
  if (own) set(out, 'equity_pct', own.ownership_pct)

  const others = rows.filter((r) => r !== own)
  // If the person filling the form has no row of their own (a representative who is not an owner),
  // every row becomes a card and the ownership total check tells the client if the figures do not fit.
  if (others.length === 0) {
    if (own) out.has_partner = 'No'
    return out
  }

  out.has_partner = 'Yes'
  out.member_count = String(others.length)
  others.forEach((r, i) => {
    const k = (name: string) => `member_${i}_${name}`
    if (isCompany(r)) {
      out[k('member_type')] = 'company'
      set(out, k('member_company_name'), r.company_name)
      set(out, k('member_company_ein'), r.ein)
      set(out, k('member_company_street'), r.address_street)
      set(out, k('member_company_city'), r.address_city)
      set(out, k('member_company_state'), r.address_state)
      set(out, k('member_company_zip'), r.address_zip)
      set(out, k('member_company_country'), normalizeCountry(r.address_country))
      set(out, k('member_rep_name'), r.representative_name)
      set(out, k('member_rep_email'), r.representative_email)
      set(out, k('member_rep_phone'), r.representative_phone)
      set(out, k('member_rep_address_street'), r.representative_address_street)
      set(out, k('member_rep_address_city'), r.representative_address_city)
      set(out, k('member_rep_address_state'), r.representative_address_state)
      set(out, k('member_rep_address_zip'), r.representative_address_zip)
      set(out, k('member_rep_address_country'), normalizeCountry(r.representative_address_country))
    } else {
      out[k('member_type')] = 'individual'
      const c = r.contact_id ? contactNames[r.contact_id] : undefined
      const split = splitFullName(r.full_name)
      set(out, k('member_first_name'), c?.first_name?.trim() ? c.first_name : split.first)
      set(out, k('member_last_name'), c?.last_name?.trim() ? c.last_name : split.last)
      set(out, k('member_email'), r.email)
      set(out, k('member_phone'), r.phone)
      set(out, k('member_street'), r.address_street)
      set(out, k('member_city'), r.address_city)
      set(out, k('member_state_province'), r.address_state)
      set(out, k('member_zip'), r.address_zip)
      set(out, k('member_country'), normalizeCountry(r.address_country))
    }
    set(out, k('member_ownership_pct'), r.ownership_pct)
  })
  return out
}

// ─── The step's rules (shared by the wizard and the tests) ───

/** Most owner cards one application can carry; anything above is a typo or an attack, never a real company. */
export const MAX_OWNER_CARDS = 50

/**
 * How many owner cards an answer set holds. The `member_count` the wizard keeps is trusted when it is a positive number;
 * without it (a card typed by hand and never "added") the highest `member_{i}_` key tells. Capped at MAX_OWNER_CARDS.
 */
export function ownerCardCount(data: Record<string, unknown>): number {
  const c = Number(data.member_count)
  if (Number.isFinite(c) && c > 0) return Math.min(Math.floor(c), MAX_OWNER_CARDS)
  let max = 0
  for (const k of Object.keys(data)) {
    const m = /^member_(\d+)_/.exec(k)
    if (m) max = Math.max(max, Number(m[1]) + 1)
  }
  return Math.min(max, MAX_OWNER_CARDS)
}

/** The person filling the form plus every card — what the bank is told in total (rounded to cents so 3 × 33.3 reads 99.9, not 99.89999…). */
export function relayOwnershipTotal(data: Record<string, unknown>, memberCount: number): number {
  let sum = 0
  const own = Number(data.equity_pct)
  if (!Number.isNaN(own)) sum += own
  for (let i = 0; i < Math.min(memberCount, MAX_OWNER_CARDS); i++) {
    const v = Number(data[`member_${i}_member_ownership_pct`])
    if (!Number.isNaN(v)) sum += v
  }
  return Math.round(sum * 100) / 100
}

/** Three owners at 33% (99%) must pass, so 0.5 either side of 100 is accepted — same tolerance as the tax form. */
export function ownershipTotalIsValid(total: number): boolean {
  return Math.abs(total - 100) <= 0.5
}

/** True when the client said the company has other owners (so the owners step has to be filled and confirmed). */
export function hasOtherOwners(data: Record<string, unknown>): boolean {
  return data.has_partner === 'Yes'
}

/**
 * The answers to post. The step no longer asks the old single-partner questions, so any `partner_*` answer left in a draft
 * is dropped (it would print as a stale partner). When the client says there are NO other owners the owner cards are
 * dropped too (staff never see an owner the client removed); when there are, the card count is stamped so a card typed by
 * hand and never "added" is still counted.
 */
export function finalizeRelayAnswers<T extends Record<string, unknown>>(data: T, memberCount: number): T {
  const out: Record<string, unknown> = {}
  const keep = hasOtherOwners(data)
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('partner_')) continue
    if (!keep && (k === 'member_count' || k === 'members_confirmed' || /^member_\d+_/.test(k))) continue
    out[k] = v
  }
  if (keep && memberCount > 0) out.member_count = Math.min(Math.floor(memberCount), MAX_OWNER_CARDS)
  return out as T
}

/**
 * The prefill for the owner cards is only for a form that has no cards yet. Once a draft (or a submitted application)
 * holds cards — or a card count — the draft IS the list: merging the CRM's per-card values underneath would put one
 * owner's EIN on another card after a card was removed, bring back a removed card, and refill a value the client cleared.
 */
export function withoutCardPrefillWhenDraftHasCards(
  prefill: Record<string, string>,
  saved: Record<string, unknown>,
): Record<string, string> {
  const draftHasCards = Object.keys(saved).some((k) => k === 'member_count' || /^member_\d+_/.test(k))
  if (!draftHasCards) return prefill
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(prefill)) {
    if (k === 'member_count' || /^member_\d+_/.test(k)) continue
    out[k] = v
  }
  return out
}

/** With no other owners the person holds the whole company: their own share must be 100% (±0.5), or the application says something impossible. */
export function soleOwnerShareIsValid(data: Record<string, unknown>): boolean {
  if (hasOtherOwners(data)) return true
  const raw = data.equity_pct
  if (raw === undefined || raw === null || raw === '') return true // blank is the "required" rule's job
  return ownershipTotalIsValid(Number(raw))
}

// ─── What staff read ───

export interface RelayOwnerView {
  kind: 'person' | 'company'
  /** person: "First Last" — company: its legal name */
  name: string
  ownershipPct: string
  email: string
  phone: string
  ein: string
  /** one line: "street, city, state zip, country" (empty parts left out) */
  address: string
  representative: { name: string; email: string; phone: string; address: string } | null
}

/**
 * The other owners of a submitted Relay application, in order, for the staff review and the filed copy.
 * Reads the new `member_{i}_*` answers; an older submission (one `partner_*` individual) is read too,
 * so nothing already submitted goes blank.
 */
export function listRelayOwners(submitted: Record<string, unknown>): RelayOwnerView[] {
  const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())
  const line = (street: string, city: string, state: string, zip: string, country: string): string =>
    [street, city, [state, zip].filter(Boolean).join(' '), country].filter(Boolean).join(', ')
  const count = ownerCardCount(submitted)
  const out: RelayOwnerView[] = []

  if (count > 0) {
    for (let i = 0; i < count; i++) {
      const g = (name: string) => str(submitted[`member_${i}_${name}`])
      if (g('member_type') === 'company') {
        const repName = g('member_rep_name')
        const repEmail = g('member_rep_email')
        out.push({
          kind: 'company',
          name: g('member_company_name'),
          ownershipPct: g('member_ownership_pct'),
          email: '',
          phone: '',
          ein: g('member_company_ein'),
          address: line(g('member_company_street'), g('member_company_city'), g('member_company_state'), g('member_company_zip'), g('member_company_country')),
          representative: repName || repEmail
            ? {
                name: repName,
                email: repEmail,
                phone: g('member_rep_phone'),
                address: line(g('member_rep_address_street'), g('member_rep_address_city'), g('member_rep_address_state'), g('member_rep_address_zip'), g('member_rep_address_country')),
              }
            : null,
        })
      } else {
        out.push({
          kind: 'person',
          name: `${g('member_first_name')} ${g('member_last_name')}`.trim(),
          ownershipPct: g('member_ownership_pct'),
          email: g('member_email'),
          phone: g('member_phone'),
          ein: '',
          address: line(g('member_street'), g('member_city'), g('member_state_province'), g('member_zip'), g('member_country')),
          representative: null,
        })
      }
    }
    return out
  }

  if (submitted.has_partner === 'Yes' && (str(submitted.partner_first_name) || str(submitted.partner_last_name))) {
    out.push({
      kind: 'person',
      name: `${str(submitted.partner_first_name)} ${str(submitted.partner_last_name)}`.trim(),
      ownershipPct: str(submitted.partner_equity_pct),
      email: str(submitted.partner_email),
      phone: str(submitted.partner_phone),
      ein: '',
      address: line(str(submitted.partner_street), str(submitted.partner_city), str(submitted.partner_state), str(submitted.partner_zip), ''),
      representative: null,
    })
  }
  return out
}

/**
 * The answers as the filed summary PDF should draw them: the owner cards become one `members_list` block per
 * owner (person, or company followed by its representative) and the raw member_N_* keys leave the payload.
 * An older application (one partner) is returned untouched — its Partner section already prints it.
 */
export function prepareRelayPayloadForPdf(data: Record<string, unknown>): Record<string, unknown> {
  if (ownerCardCount(data) <= 0) return data
  const owners = listRelayOwners(data)
  if (owners.length === 0) return data
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    // the cards replace any single partner an older draft still carries
    if (k === 'member_count' || k === 'members_confirmed' || k.startsWith('partner_') || /^member_\d+_/.test(k)) continue
    out[k] = v
  }
  const put = (item: Record<string, unknown>, key: string, value: string): void => {
    if (value) item[key] = value
  }
  out.members_list = owners.map((o) => {
    const item: Record<string, unknown> = {}
    put(item, 'owner_kind', o.kind === 'company' ? 'Company' : 'Person')
    put(item, 'owner_name', o.name)
    put(item, 'owner_ownership', o.ownershipPct ? `${o.ownershipPct}%` : '')
    put(item, 'owner_ein', o.ein)
    put(item, 'owner_email', o.email)
    put(item, 'owner_phone', o.phone)
    put(item, 'owner_address', o.address)
    if (o.representative) {
      put(item, 'owner_rep_name', o.representative.name)
      put(item, 'owner_rep_email', o.representative.email)
      put(item, 'owner_rep_phone', o.representative.phone)
      put(item, 'owner_rep_address', o.representative.address)
    }
    return item
  })
  return out
}
