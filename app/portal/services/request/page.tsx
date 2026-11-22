/**
 * Service Request Page — Clients can browse and request new services.
 * Available for all tiers (lead, onboarding, active, full).
 * Creates a chat message + CRM task when submitted.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getClientContactId } from '@/lib/portal-auth'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability } from '@/lib/portal/team/capabilities'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { ServiceRequestClient } from './service-request-client'
import { redirectIfHiddenForServiceScope } from '@/lib/portal/service-scope-server'
import { SERVICE_SCOPED_PAGE_KEYS } from '@/lib/portal/service-scope'

export default async function ServiceRequestPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')
  // A service-scoped login (one bought service) never opens this page; the menu hides it too (lib/portal/service-scope.ts).
  await redirectIfHiddenForServiceScope(user, SERVICE_SCOPED_PAGE_KEYS.requestService)

  const contactId = getClientContactId(user)
  const userName = user.user_metadata?.full_name || user.email?.split('@')[0] || ''

  // Resolve the current account so the submitted chat message lands on the
  // account chat (not the contact-fallback chat). Prefer the cookie set by
  // the account switcher; fall back to the contact's first account link.
  let accountId = ''
  if (!contactId) {
    // A team login (no contact): allowed only with the "Can ask for new services" tick, and always for its OWN company.
    const identity = await resolvePortalIdentity(user)
    if (identity.kind !== 'teammate' || !hasCapability(identity.capabilities, 'request_services')) redirect('/portal')
    accountId = identity.accountId
  }
  if (contactId) {
    const cookieAccountId = (await cookies()).get('portal_account_id')?.value
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .is('access_revoked_at', null)
      .eq('contact_id', contactId)

    if (links?.length) {
      accountId =
        cookieAccountId && links.find(l => l.account_id === cookieAccountId)
          ? cookieAccountId
          : links[0].account_id
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <ServiceRequestClient
        contactId={contactId || ''}
        accountId={accountId}
        userName={userName}
      />
    </div>
  )
}
