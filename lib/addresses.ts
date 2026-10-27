import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { TD_OFFICE } from '@/lib/td-address'
import { STATE_NAMES } from '@/lib/formation/registered-agent-state'

// Full row shape returned by GET /api/addresses (includes computed linked_account_count).
export interface AddressRow {
  id: string
  kind: AddressKind
  name: string
  provider: string | null
  agent_name: string | null
  address_line1: string
  address_line2: string | null
  city: string
  state: string
  zip: string
  country: string
  county: string | null
  is_td_provided: boolean
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
  created_by: string | null
  linked_account_count: number
}

// Supabase row shape returned by joining addresses!business_mailing_address_id
export interface MailingAddressRow {
  address_line1: string | null
  address_line2?: string | null
  city: string | null
  state: string | null
  zip: string | null
  is_td_provided?: boolean
}

// Build a single-line address string from a structured addresses row.
// Used for real documents (invoice/payment PDFs, emails, OA/SS-4 generation,
// the AI agent client card) where a plain joined line is required — NOT for
// the portal's own address cards, which render each field on its own
// labeled line instead (see AddressCard/AddressInfoRow). Reverted to the
// comma format 2026-09-18 after the dash-separator change (dev job
// 254834cc) leaked into these document call sites unreviewed.
export function formatAddressString(addr: MailingAddressRow | null | undefined): string | null {
  if (!addr?.address_line1) return null
  const parts: string[] = [addr.address_line1.trim()]
  if (addr.address_line2?.trim()) parts.push(addr.address_line2.trim())
  const csz = [addr.city?.trim(), addr.state?.trim(), addr.zip?.trim()].filter(Boolean).join(' ')
  if (csz) parts.push(csz)
  return parts.join(', ')
}

// ─── The four addresses (Antonio 2026-10-10, applies to every client now) ─────────────────────────────────────────
//   a) OFFICIAL / legal / physical address — "10225 Ulmerton Rd 3D, Largo, FL 33771". The 3D is part of OUR building's address:
//      the same for every client, no company number on it. This is what the Articles, the EIN application (SS-4 line 4a),
//      the Operating Agreement and the lease premises show.
//   b) MAILING address — the same address plus the client's own box: "10225 Ulmerton Rd 3D PMB 318, Largo, FL 33771".
//      Only the PMB number changes per client. The company's number is stored as "3D-318" (accounts.suite_number, locked by
//      the database); the PMB number is derived from it here — nothing else builds this string.
//   c) REGISTERED AGENT — as usual (the company's own saved row).
//   d) SHIPPING address — our Seminole office, shown to every client in the portal.
// A company with NO number yet (for example a One-Time company with no TD office service) has neither a), nor b): Largo is not
// its address. It keeps what it had before (a saved real address, else "not on file").
const TD_LARGO_LINE1 = /^\s*10225\s+ulmerton\s+r(?:oa)?d\b/i

export function isTdLargoAddressRow(row: { address_line1?: string | null } | null | undefined): boolean {
  return !!row?.address_line1 && TD_LARGO_LINE1.test(row.address_line1)
}

export const TD_LARGO_STREET_3D = '10225 Ulmerton Rd 3D'
export const TD_LARGO_CITY = 'Largo'
export const TD_LARGO_STATE = 'FL'
export const TD_LARGO_ZIP = '33771'

/** "3D-318" -> "318" (the PMB number). Anything not shaped like a numbered TD suite -> null. */
export function pmbNumberFromSuite(suite: string | null | undefined): string | null {
  const m = /^\s*3D-(\d{3,4})\s*$/i.exec(suite ?? '')
  return m ? m[1] : null
}

type LargoRow = { address_line1: string; address_line2: null; city: string; state: string; zip: string; country: string }

/** What staff and clients see for a company's number: "PMB 328" — never the stored "3D-328". Null when it has no number. */
export function pmbLabel(suite: string | null | undefined): string | null {
  const pmb = pmbNumberFromSuite(suite)
  return pmb ? `PMB ${pmb}` : null
}

/**
 * What staff type for a number -> the stored form. "328" / "3D-328" / "3d328" -> "3D-328". Anything else comes back trimmed, so
 * the server's own validation still rejects it with its normal message.
 */
export function suiteFromPmbInput(input: string): string {
  const t = input.trim()
  const m = /^(?:3D\s*-?\s*)?(\d{2,4})$/i.exec(t)
  return m ? `3D-${m[1].padStart(3, '0')}` : t
}

/** Street line of the mailing address: "10225 Ulmerton Rd 3D PMB 318"; null when the company has no number. */
export function mailingStreetForSuite(suite: string | null | undefined): string | null {
  const pmb = pmbNumberFromSuite(suite)
  return pmb ? `${TD_LARGO_STREET_3D} PMB ${pmb}` : null
}

/** The OFFICIAL address row — same for every company that has a number; null when it has none. */
export function companyOfficialRow(suite: string | null | undefined): LargoRow | null {
  if (!pmbNumberFromSuite(suite)) return null
  return { address_line1: TD_LARGO_STREET_3D, address_line2: null, city: TD_LARGO_CITY, state: TD_LARGO_STATE, zip: TD_LARGO_ZIP, country: 'US' }
}

/** The MAILING address row — official address + this company's PMB; null when it has no number. */
export function companyMailingRow(suite: string | null | undefined): LargoRow | null {
  const street = mailingStreetForSuite(suite)
  if (!street) return null
  return { address_line1: street, address_line2: null, city: TD_LARGO_CITY, state: TD_LARGO_STATE, zip: TD_LARGO_ZIP, country: 'US' }
}

/**
 * The address row as it should be shown for THIS company when a Largo office row is picked for a role. Official roles
 * (Articles / principal office) get the bare 3D address, the mailing role gets 3D + the company's PMB; every other
 * address (Seminole, registered agent, ...) and a company with no number come back untouched.
 */
export function withCompanySuite<T extends { address_line1?: string | null; address_line2?: string | null }>(
  row: T | null | undefined,
  companySuite: string | null | undefined,
  kind: AddressKind = 'business_legal',
): T | null | undefined {
  if (!row || !pmbNumberFromSuite(companySuite) || !isTdLargoAddressRow(row)) return row
  if (kind === 'business_mailing') return { ...row, ...companyMailingRow(companySuite)! }
  if (kind === 'business_legal') return { ...row, ...companyOfficialRow(companySuite)! }
  return row
}

/**
 * The Principal Office card a CLIENT sees. A company with a number: the OFFICIAL address (computed, whatever row is saved).
 * A company with no number yet: its saved Principal Office — but NEVER the shared Largo row (a bare "3D" is not its address
 * when it has no TD office service), so it sees "not on file".
 */
export function principalOfficeForClient<T extends MailingAddressRow>(
  legal: T | null | undefined,
  mailing: T | null | undefined,
  companySuite: string | null | undefined,
): T | MailingAddressRow | null {
  const official = companyOfficialRow(companySuite)
  if (official) return official
  // no number yet: the first saved row that is NOT the shared Largo office
  return [legal, mailing].find(r => !!r?.address_line1 && !isTdLargoAddressRow(r)) ?? null
}

/** The Mailing Address card a CLIENT sees: official address + their own PMB. No number yet -> null ("not on file"). */
export function mailingForClient(companySuite: string | null | undefined): (MailingAddressRow & { country: string }) | null {
  // no `name`: the card prints the COMPANY's own name above its mailing address (the Shipping card is the one in TD's name)
  return companyMailingRow(companySuite)
}

/**
 * The Shipping Address card a CLIENT sees: our Seminole office, the same for every client (Antonio 2026-10-10). It is also
 * where clients post original documents to us.
 */
export const TD_SHIPPING_ROW: MailingAddressRow & { name: string; country: string } = {
  name: TD_OFFICE.company,
  address_line1: TD_OFFICE.streetNoSuite,
  address_line2: TD_OFFICE.street.slice(TD_OFFICE.streetNoSuite.length).replace(/^,\s*/, ''),
  city: TD_OFFICE.city,
  state: TD_OFFICE.state,
  zip: TD_OFFICE.zip,
  country: 'US',
}

export function shippingForClient(): typeof TD_SHIPPING_ROW {
  return TD_SHIPPING_ROW
}

// The company's MAILING address as one line (invoices, the AI card): official address + its PMB when it has a number, else the
// saved FK row, else the legacy physical_address text column. A company with NO number is not at our Largo office, so the shared
// Largo row (a bare "3D") and a Largo-formatted legacy text are ignored for it — it keeps a real saved address or has none.
export function resolveMailingAddress(
  mailingRow: MailingAddressRow | null | undefined,
  legacyPhysical: string | null | undefined,
  companySuite?: string | null,
): string | null {
  const mailing = companyMailingRow(companySuite)
  if (mailing) return formatAddressString(mailing)
  const realRow = isTdLargoAddressRow(mailingRow) ? null : mailingRow
  const realLegacy = isTdLargoAddressRow({ address_line1: legacyPhysical }) ? null : legacyPhysical
  return formatAddressString(realRow) ?? realLegacy ?? null
}

// Builds SS-4 Line 6 string from structured registry columns.
// county = "Sheridan", stateCode = "WY" → "Sheridan County, Wyoming"
export function formatCountyAndState(county: string, stateCode: string): string {
  const stateName = STATE_NAMES[stateCode.toUpperCase()] ?? stateCode
  return `${county} County, ${stateName}`
}

export const VALID_KINDS = ['business_legal', 'business_mailing', 'registered_agent', 'shipping'] as const
export type AddressKind = (typeof VALID_KINDS)[number]

export function isValidKind(k: unknown): k is AddressKind {
  return VALID_KINDS.includes(k as AddressKind)
}

export function freshAddressClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

// Count active (not Cancelled/Closed) accounts referencing addressId across
// all four FK columns. Used by PATCH (return count) and DELETE (guard).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function linkedAccountCount(db: SupabaseClient<Database>, addressId: string): Promise<number> {
  const { count, error } = await (db as any)
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .or(
      `business_legal_address_id.eq.${addressId},` +
      `business_mailing_address_id.eq.${addressId},` +
      `registered_agent_id.eq.${addressId},` +
      `shipping_address_id.eq.${addressId}`
    )
    .not('status', 'in', '("Cancelled","Closed")')
  if (error) throw new Error(error.message)
  return count ?? 0
}

// Find the first active row with same kind + address_line1 + city + state
// (case-insensitive). Excludes excludeId so PATCH doesn't flag itself.
// Near-dupe check runs on POST only (§2 #4 — Add new only).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nearDupeCheck(
  db: SupabaseClient<Database>,
  kind: AddressKind,
  address_line1: string,
  city: string,
  state: string,
  excludeId?: string
): Promise<{ id: string; name: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (db as any)
    .from('addresses')
    .select('id, name')
    .eq('kind', kind)
    .eq('active', true)
    .ilike('address_line1', address_line1.trim())
    .ilike('city', city.trim())
    .ilike('state', state.trim())
    .limit(1)

  if (excludeId) query = query.neq('id', excludeId)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data as Array<{ id: string; name: string }> | null)?.[0] ?? null
}
