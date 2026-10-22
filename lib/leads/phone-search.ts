import type { SupabaseClient } from '@supabase/supabase-js'

// Lead phones are stored exactly as typed ("+39 333 000 0001", "+39-347-633-3031",
// "+393398755257"), so a plain text match on the column cannot find a number typed
// in a different format. We compare digits only instead.

const MIN_DIGITS = 4
const PAGE = 1000
// Each id adds ~37 characters to the request URL; a broad number ("+39 33") must not build an oversized one.
export const MAX_PHONE_IDS = 200

export function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

/** Digits of the search text if it looks like a phone number, otherwise null. */
export function phoneSearchDigits(query: string): string | null {
  const q = query.trim()
  if (!q || /[^\d\s+\-().]/.test(q)) return null
  const digits = phoneDigits(q)
  return digits.length >= MIN_DIGITS ? digits : null
}

export function phoneMatches(phone: string | null | undefined, searchDigits: string): boolean {
  return phoneDigits(phone).includes(searchDigits)
}

/**
 * Ids of leads whose phone contains the typed number (any formatting), capped at MAX_PHONE_IDS.
 * Empty when the text is not a phone. Never throws: if the lookup fails the caller just gets
 * the normal name/email search.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function findLeadIdsByPhone(supabase: SupabaseClient<any, any, any>, query: string): Promise<string[]> {
  const digits = phoneSearchDigits(query)
  if (!digits) return []

  try {
    const ids: string[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, phone')
        .not('phone', 'is', null)
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { id: string; phone: string | null }[]
      for (const r of rows) if (phoneMatches(r.phone, digits)) ids.push(r.id)
      if (ids.length >= MAX_PHONE_IDS) {
        console.warn(`[leads] phone search "${digits}" matched at least ${MAX_PHONE_IDS} leads — list capped`)
        return ids.slice(0, MAX_PHONE_IDS)
      }
      if (rows.length < PAGE) break
    }
    return ids
  } catch (err) {
    console.error('[leads] phone search lookup failed — falling back to name/email only:', err)
    return []
  }
}

/** Quote a value for a PostgREST filter so ( ) , and quotes in typed text cannot break the filter. */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The `.or()` filter for the leads search box: name, email, and (for phone-looking text) matching phones. */
export function leadSearchOrFilter(query: string, phoneIds: string[]): string {
  const pattern = quoteFilterValue(`%${query}%`)
  const parts = [`full_name.ilike.${pattern}`, `email.ilike.${pattern}`]
  if (phoneIds.length > 0) parts.push(`id.in.(${phoneIds.join(',')})`)
  return parts.join(',')
}
