/**
 * TD Communication — client-facing page (Phase 9: DB-driven content).
 *
 * The marketing content (hero, problem statement, CTA, portfolio) + the
 * Coming-Soon ⇄ full-landing switch now come from the database
 * (app_settings 'td_communication_landing', edited in the CRM Landing Page tab
 * and on /collab) instead of being hardcoded. The fixed layout is rendered by
 * the shared <TdCommLanding> component (same one the editor previews).
 *
 *   published.coming_soon = true  → "Coming Soon" teaser (DB copy)
 *   published.coming_soon = false → full landing page (hero → problem → packages
 *                                   → portfolio → CTA), packages from td_comm_packages
 *
 * The Phase 5/6 enrollment-aware footer (Start your brand audit / received /
 * notify) is PRESERVED and layered below the marketing content.
 *
 * Bilingual via getLocale (user metadata). Server component, mirrors the
 * /portal/banks pattern: auth guard → locale → render.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getLocale } from '@/lib/portal/i18n'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientActiveEnrollment } from '@/lib/td-communication/brand-audit'
import { getPublishedLanding, listLandingPackages } from '@/lib/td-communication/landing'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { resolveDisclaimerText, currentDisclaimerVersion, canRevealConcept } from '@/lib/td-communication/disclaimer'
import { hasAcceptedDisclaimer } from '@/lib/td-communication/disclaimer-queries'
import { resolveSubject } from '@/lib/td-communication/subject'
import { getActiveConsentForEnrollment, resolveShowcaseConsentText } from '@/lib/td-communication/showcase-consent'
import { TdCommLanding } from '@/components/td-communication/td-comm-landing'
import { ConceptReveal } from '@/components/td-communication/concept-reveal'
import { ShowcaseConsentCard } from '@/components/td-communication/showcase-consent-card'
import { SocialKitCard } from '@/components/td-communication/social-kit-card'
import { BellRing, ArrowRight, CheckCircle2 } from 'lucide-react'

export const dynamic = 'force-dynamic'

const WIZARD_HREF = '/portal/wizard?type=td_communication'

export default async function TdCommunicationPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const locale = getLocale(user)
  const isIt = locale === 'it'

  // Published landing content + (only when live) the active packages grid.
  const published = await getPublishedLanding()
  const comingSoon = published.coming_soon
  const packages = comingSoon ? [] : await listLandingPackages()

  // Phase 5/6 — detect the client's active brand-audit enrollment by their whole
  // identity (contact OR any owned account), so the right footer CTA shows.
  const contactId = getClientContactId(user)
  const ownedAccountIds: string[] = []
  if (contactId) {
    const { data: acLinks } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)
    for (const l of acLinks ?? []) {
      if (l.account_id && !ownedAccountIds.includes(l.account_id)) ownedAccountIds.push(l.account_id)
    }
  }
  const enrollment = (contactId || ownedAccountIds.length > 0)
    ? await getClientActiveEnrollment(contactId, ownedAccountIds)
    : null
  // Phase 7 — once the concept is ready (or already approved), this page becomes
  // the disclaimer gate + cinematic logo reveal instead of the marketing landing
  // (the client is past marketing). No image URLs are passed to the client here —
  // the reveal fetches them from the API only after the disclaimer is accepted.
  if (enrollment && canRevealConcept(enrollment.status)) {
    const settings = await getCommSettings()
    const version = currentDisclaimerVersion(settings)
    const [accepted, subject] = await Promise.all([
      hasAcceptedDisclaimer(enrollment.id, version),
      resolveSubject(enrollment),
    ])
    return (
      <ConceptReveal
        initialStatus={enrollment.status}
        disclaimerAccepted={accepted}
        disclaimerText={resolveDisclaimerText(settings, locale)}
        companyName={subject.name}
        locale={isIt ? 'it' : 'en'}
      />
    )
  }

  const hasEnrollment = !!enrollment
  const formSubmitted = !!enrollment?.metadata?.form_submitted_at

  // Phase 14 — once the project is delivered, invite the client to be featured in
  // the public portfolio (opt-in, revocable). Resolve their current consent state
  // server-side so the card shows the right variant. Wrapped defensively: a consent
  // lookup failure (e.g. the table not yet migrated in an environment) must NEVER
  // 500 the client's page — it just hides the (non-essential) opt-in card.
  // Phase 15 — once delivered, the client can self-serve their social sharing kit
  // (the card self-hides when the kill-switch is off or no kit was released).
  let socialKitCard: React.ReactNode = null
  let consentCard: React.ReactNode = null
  if (enrollment && enrollment.status === 'delivered') {
    socialKitCard = <SocialKitCard locale={isIt ? 'it' : 'en'} />
    try {
      const activeConsent = await getActiveConsentForEnrollment(enrollment.id)
      consentCard = (
        <ShowcaseConsentCard
          initialConsented={!!activeConsent}
          consentText={resolveShowcaseConsentText(locale)}
          locale={isIt ? 'it' : 'en'}
        />
      )
    } catch (err) {
      console.error('td-communication portal — showcase consent lookup failed (card hidden):', err)
    }
  }

  // Footer copy (unchanged from the Phase 5/6 teaser).
  const ctaTitle = isIt ? 'Il tuo brand audit è pronto' : 'Your brand audit is ready'
  const ctaSub = isIt
    ? 'Raccontaci il tuo brand: bastano pochi minuti per iniziare.'
    : 'Tell us about your brand — it only takes a few minutes to get started.'
  const ctaButton = isIt ? 'Inizia il tuo brand audit' : 'Start your brand audit'
  const submittedTitle = isIt ? 'Brand audit ricevuto' : 'Brand audit received'
  const submittedSub = isIt
    ? 'Grazie! Il nostro team sta lavorando al tuo brand.'
    : 'Thank you! Our team is working on your brand.'
  const notify = isIt
    ? 'Ti avviseremo non appena sarà pronto.'
    : "We'll notify you when it's ready."

  const startCta = (
    <div className="mt-8 flex flex-col items-center gap-4 rounded-2xl border border-blue-200 bg-blue-50/60 px-6 py-7 text-center">
      <div>
        <h3 className="text-base font-semibold text-blue-900">{ctaTitle}</h3>
        <p className="mt-1 text-sm text-blue-900/80">{ctaSub}</p>
      </div>
      <Link
        href={WIZARD_HREF}
        className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
      >
        {ctaButton}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  )
  const receivedNote = (
    <div className="mt-8 flex items-center justify-center gap-3 rounded-2xl border border-green-100 bg-green-50/70 px-6 py-4 text-center">
      <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
      <p className="text-sm font-medium text-green-900">
        <span className="font-semibold">{submittedTitle}.</span> {submittedSub}
      </p>
    </div>
  )
  const notifyBanner = (
    <div className="mt-8 flex items-center justify-center gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 px-6 py-4 text-center">
      <BellRing className="h-5 w-5 shrink-0 text-blue-600" />
      <p className="text-sm font-medium text-blue-900">{notify}</p>
    </div>
  )

  // Footer logic:
  // - Coming Soon: unchanged Phase 5/6 behavior (start / received / notify).
  // - Full landing: the page's own CTA covers "start"; only confirm if submitted.
  let footer: React.ReactNode = null
  if (comingSoon) {
    footer = hasEnrollment && !formSubmitted ? startCta : hasEnrollment && formSubmitted ? receivedNote : notifyBanner
  } else if (formSubmitted) {
    footer = receivedNote
  }

  return (
    <div>
      <TdCommLanding
        content={published}
        packages={packages}
        locale={locale}
        ctaHref={comingSoon ? undefined : WIZARD_HREF}
      />
      {(footer || socialKitCard || consentCard) && (
        <div className="px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto pb-6">
          {footer}
          {socialKitCard}
          {consentCard}
        </div>
      )}
    </div>
  )
}
