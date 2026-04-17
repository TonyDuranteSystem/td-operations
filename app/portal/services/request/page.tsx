/**
 * Service Request Page — Clients can browse and request new services.
 * Available for all tiers (lead, onboarding, active, full).
 * Creates a chat message + CRM task when submitted.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getClientContactId } from '@/lib/portal-auth'
import { getLocale } from '@/lib/portal/i18n'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { ServiceRequestClient } from './service-request-client'

export default async function ServiceRequestPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  const locale = getLocale(user)
  const userName = user.user_metadata?.full_name || user.email?.split('@')[0] || ''

  // Resolve the current account so the submitted chat message lands on the
  // account chat (not the contact-fallback chat). Prefer the cookie set by
  // the account switcher; fall back to the contact's first account link.
  let accountId = ''
  if (contactId) {
    const cookieAccountId = (await cookies()).get('portal_account_id')?.value
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
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
        locale={locale}
      />
    </div>
  )
}
