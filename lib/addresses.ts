import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

// Builds SS-4 Line 6 string from structured registry columns.
// county = "Sheridan", stateCode = "WY" → "Sheridan County, Wyoming"
export function formatCountyAndState(county: string, stateCode: string): string {
  const stateName = STATE_NAMES[stateCode.toUpperCase()] ?? stateCode
  return `${county} County, ${stateName}`
}

export const VALID_KINDS = ['business_legal', 'business_mailing', 'registered_agent'] as const
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
// all three FK columns. Used by PATCH (return count) and DELETE (guard).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function linkedAccountCount(db: SupabaseClient<Database>, addressId: string): Promise<number> {
  const { count, error } = await (db as any)
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .or(
      `business_legal_address_id.eq.${addressId},` +
      `business_mailing_address_id.eq.${addressId},` +
      `registered_agent_id.eq.${addressId}`
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
