/**
 * Server side of the service-scoped portal login (lib/portal/service-scope.ts has the rule and its reasons).
 *  - navKeysUnlockedByServices: the menu entries the services a company holds add back (catalog data).
 *  - redirectIfHiddenForServiceScope: the guard every hidden page calls, so a page the menu hides is also refused when its address is typed.
 */
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalTierByContact } from '@/lib/portal/queries'
import { getEntryByServiceType } from '@/lib/services'
import { isServiceScopedLogin, portalNavKeysOf, scopedNavKeyHidden } from '@/lib/portal/service-scope'

/** The service types a company holds right now (open jobs). */
export async function activeServiceTypesOf(accountId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('service_deliveries')
    .select('service_type')
    .eq('account_id', accountId)
    .in('status', ['active', 'on_hold'])
  return Array.from(new Set((data ?? []).map((d) => d.service_type as string).filter(Boolean)))
}

/**
 * The menu entries the given service types add back for a service-scoped login: each service's catalog row says so in `metadata.portal_nav_keys`.
 * A lookup that fails adds nothing (the login stays limited — never wider than intended).
 */
export async function navKeysUnlockedByServices(serviceTypes: readonly string[]): Promise<string[]> {
  const keys = new Set<string>()
  for (const type of serviceTypes) {
    try {
      const entry = await getEntryByServiceType(type)
      for (const k of portalNavKeysOf(entry?.metadata)) keys.add(k)
    } catch {
      /* a catalog read that fails adds nothing */
    }
  }
  return Array.from(keys)
}

/**
 * Guard for a portal page that a service-scoped login must not open (the menu hides the same entry). Sends that login to the portal home; everyone else
 * passes untouched. Team members and staff (no contact on the login) are never touched here — they have their own guards. Fails OPEN on a lookup
 * error so a database hiccup never locks a client out of a page they are entitled to (the menu rule is the first line, this is the second).
 */
export async function redirectIfHiddenForServiceScope(user: User, navKey: string): Promise<void> {
  let hidden = false
  try {
    const contactId = getClientContactId(user)
    if (!contactId) return
    const accounts = await getPortalAccounts(contactId)
    if (accounts.length === 0) {
      // a person with no company: limited only at the active level (a personal service); nothing is added back (no company, no company services)
      hidden = isServiceScopedLogin({ hasCompany: false, portalTier: await getPortalTierByContact(contactId) }) && scopedNavKeyHidden(navKey)
    } else {
      const cookieAccountId = (await cookies()).get('portal_account_id')?.value
      const selected = accounts.find((a) => a.id === cookieAccountId) ?? accounts[0]
      if (!isServiceScopedLogin({ accountType: selected.account_type ?? null, hasCompany: true })) return
      const unlocked = await navKeysUnlockedByServices(await activeServiceTypesOf(selected.id))
      hidden = scopedNavKeyHidden(navKey, unlocked)
    }
  } catch {
    return
  }
  if (hidden) redirect('/portal')
}
