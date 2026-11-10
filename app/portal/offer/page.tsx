/**
 * Portal Offer Page — Lead tier clients see their offer here.
 *
 * Server component that:
 * 1. Gets the logged-in user's contact email
 * 2. Finds the offer linked to that email (via leads or offers.client_email)
 * 3. Embeds the existing offer page in an iframe with auto-verification
 *
 * The iframe approach reuses all 777 lines of the existing offer page
 * (bilingual, contract signing, payment flow) without duplication.
 * The email gate is bypassed because we pass the access code directly.
 */

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { APP_BASE_URL } from '@/lib/config'
import { PortalOfferClient } from './portal-offer-client'
import { getClientAppMode } from '@/lib/app-mode/server'
import { isClientAppPayEnabled } from '@/lib/portal-app/enabled'
import { getLocale, t } from '@/lib/portal/i18n'

export default async function PortalOfferPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">Please log in to view your offer.</p>
      </div>
    )
  }

  // Inside the client iPhone app, with the app's Pay switch OFF, the offer is not drawn: it is one embedded page that signs the agreement and
  // then takes the card payment itself, so the switch cannot hide only the payment. The website never takes this branch.
  if (getClientAppMode() && !(await isClientAppPayEnabled())) {
    const locale = getLocale(user)
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center" data-testid="app-offer-unavailable">
        <h2 className="text-lg font-semibold text-zinc-900">{t('app.offerPayUnavailable.title', locale)}</h2>
        <p className="text-sm text-zinc-600">{t('app.offerPayUnavailable.body', locale)}</p>
      </div>
    )
  }

  // Get contact email
  const contactId = getClientContactId(user)
  let contactEmail = user.email

  if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('email')
      .eq('id', contactId)
      .single()
    if (contact?.email) contactEmail = contact.email
  }

  if (!contactEmail) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">No email associated with your account.</p>
      </div>
    )
  }

  // Find the offer for this client (most recent non-expired)
  const { data: offer } = await supabaseAdmin
    .from('offers')
    .select('token, access_code, status, client_name, language')
    .eq('client_email', contactEmail)
    .not('status', 'eq', 'expired')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!offer) {
    // Also try via lead
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('email', contactEmail)
      .limit(1)
      .maybeSingle()

    if (lead) {
      const { data: leadOffer } = await supabaseAdmin
        .from('offers')
        .select('token, access_code, status, client_name, language')
        .eq('lead_id', lead.id)
        .not('status', 'eq', 'expired')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (leadOffer) {
        const offerUrl = `${APP_BASE_URL}/offer/${leadOffer.token}/${leadOffer.access_code}`
        return <PortalOfferClient offerUrl={offerUrl} status={leadOffer.status} clientName={leadOffer.client_name} language={leadOffer.language} />
      }
    }

    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No active proposal found.</p>
          <p className="text-zinc-400 text-sm">If you&apos;ve received a proposal, it may have expired or already been completed.</p>
        </div>
      </div>
    )
  }

  const offerUrl = `${APP_BASE_URL}/offer/${offer.token}/${offer.access_code}`
  return <PortalOfferClient offerUrl={offerUrl} status={offer.status} clientName={offer.client_name} language={offer.language} />
}
