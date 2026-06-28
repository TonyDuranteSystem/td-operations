import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { partnerHasCommScope } from '@/lib/td-communication/helpers'

/**
 * Partner auth helpers.
 *
 * A managed partner (first user: Cris) authenticates as a Supabase user with
 *   app_metadata.role = 'partner'
 *   app_metadata.contact_id = <contacts.id>
 * and is linked to a `client_partners` record by that contact_id. Per-surface
 * access is gated by `client_partners.partner_scope` (a text[]).
 *
 * NOTE on middleware: middleware.ts confines role='partner' users to /collab +
 * /api/conversations (everything else redirects to /collab), so a partner can
 * never reach the CRM. The /collab page then does the real gate (isPartner +
 * partner_scope contains 'td_communication').
 */

export function isPartner(user: User | null): boolean {
  if (!user) return false
  return user.app_metadata?.role === 'partner'
}

/**
 * Whether a partner has ANY non-empty scope. Used as the login-admission gate:
 * a partner account with no / empty scope is rejected at login so a rogue
 * scopeless partner never gets a session (defense in depth — per-surface scope,
 * e.g. 'td_communication' for /collab, is still enforced at each surface).
 * Tolerant of null/undefined/non-array (default-deny).
 */
export function hasAnyPartnerScope(scope: unknown): boolean {
  return Array.isArray(scope) && scope.length > 0
}

export function getPartnerContactId(user: User): string | null {
  return user.app_metadata?.contact_id ?? null
}

export interface PartnerRecord {
  id: string
  partner_name: string | null
  partner_scope: string[]
}

/**
 * Resolve the client_partners record for a partner user via their contact_id.
 * Returns null when the user is not a partner or has no linked partner record.
 */
export async function getPartnerForUser(user: User): Promise<PartnerRecord | null> {
  const contactId = getPartnerContactId(user)
  if (!contactId) return null

  // partner_scope was added by the TD Communication migration and is not yet in
  // the generated Supabase types (gen:types reads production). Use an untyped
  // client for this select, consistent with the td_* table access in queries.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('client_partners')
    .select('id, partner_name, partner_scope')
    .eq('contact_id', contactId)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id as string,
    partner_name: (data.partner_name as string | null) ?? null,
    partner_scope: (data.partner_scope as string[] | null) ?? [],
  }
}

/**
 * Full gate for the TD Communication partner surface: the user must have
 * role='partner' AND a linked partner record whose scope includes
 * 'td_communication'. Returns the partner record on success, else null.
 */
export async function getCommPartner(user: User | null): Promise<PartnerRecord | null> {
  if (!isPartner(user)) return null
  const partner = await getPartnerForUser(user as User)
  if (!partner || !partnerHasCommScope(partner.partner_scope)) return null
  return partner
}
