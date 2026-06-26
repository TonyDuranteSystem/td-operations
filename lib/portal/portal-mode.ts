import { supabaseAdmin } from '@/lib/supabase-admin'

export type PortalMode = 'client' | 'partner'

export interface PortalModeContext {
  /** Has a client_partners row → can use the partner portal. */
  partnerCapable: boolean
  /** Has client-side presence (company membership) → can use the client portal. */
  clientCapable: boolean
  /** Both → show the Client ⇄ Partner switcher. */
  dual: boolean
  /** The effective mode after applying capability + the portal_mode cookie. */
  mode: PortalMode
}

/**
 * Resolve which portal a contact should see. A person can be BOTH a client
 * (their own company) and a partner (refers others) — e.g. Auralba. For a
 * dual-role person the active view is driven by the `portal_mode` cookie and a
 * switcher; a single-role person is locked to their one mode. Pure single DB
 * read (client_partners existence); `clientCapable` is passed in by the caller
 * (it already loaded the accounts).
 */
export async function resolvePortalMode(
  contactId: string | null | undefined,
  clientCapable: boolean,
  cookieMode: string | null | undefined,
): Promise<PortalModeContext> {
  let partnerCapable = false
  if (contactId) {
    const { data } = await supabaseAdmin
      .from('client_partners')
      .select('id')
      .eq('contact_id', contactId)
      .maybeSingle()
    partnerCapable = !!data
  }

  const { dual, mode } = decidePortalMode({ partnerCapable, clientCapable, cookieMode })
  return { partnerCapable, clientCapable, dual, mode }
}

/**
 * Pure mode decision: dual-role honors the cookie (default client); single-role
 * is locked to its one capability; nobody → client. Unit tested.
 */
export function decidePortalMode(input: {
  partnerCapable: boolean
  clientCapable: boolean
  cookieMode: string | null | undefined
}): { dual: boolean; mode: PortalMode } {
  const dual = input.partnerCapable && input.clientCapable
  let mode: PortalMode
  if (dual) mode = input.cookieMode === 'partner' ? 'partner' : 'client'
  else if (input.partnerCapable) mode = 'partner'
  else mode = 'client'
  return { dual, mode }
}
