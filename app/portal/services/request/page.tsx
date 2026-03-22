/**
 * Service Request Page — Clients can browse and request new services.
 * Available for all tiers (lead, onboarding, active, full).
 * Creates a chat message + CRM task when submitted.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getLocale } from '@/lib/portal/i18n'
import { ServiceRequestClient } from './service-request-client'

export default async function ServiceRequestPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  const locale = getLocale(user)
  const userName = user.user_metadata?.full_name || user.email?.split('@')[0] || ''

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <ServiceRequestClient
        contactId={contactId || ''}
        userName={userName}
        locale={locale}
      />
    </div>
  )
}
