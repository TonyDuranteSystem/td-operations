/**
 * An offboarded client who NEVER set a password sees the offboarded message and nothing else (dev job 31dfd3a6, Antonio 25 Nov 2026:
 * "it shouldn't set up any password, just it should see the message and stop").
 *
 * Why this exists: a login that still has `user_metadata.must_change_password` is sent to "Set Your Password" by the portal's
 * PasswordGate (a browser-side redirect, components/portal/password-gate.tsx) on EVERY portal page. For a client whose companies are
 * all being offboarded the notice rendered for a moment and was then replaced by that page. The portal layout now draws the notice
 * ALONE (no menu, no password step, none of the other pages) for exactly this person — the same pattern as a teammate still on a
 * temporary password. The server never enforced the flag (middleware.ts does not read it), so nothing is loosened: only what the screen shows.
 *
 * The rule is the home page's own notice rule (lib/portal/closed-company.ts) plus the conditions under which the home page reaches it:
 * no visible company, nothing being formed or onboarded, not a formation-tier login, not a partner, no CLOSED company (that notice has its
 * own "Request a Service" button and stays as it is), and no new offer being sold. Pure, so the layout and the tests use one rule.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getOffboardingCompanyNames, getClosedCompanyNames } from '@/lib/portal/queries'
import { showOffboardingCompanyNotice } from '@/lib/portal/closed-company'

export function isOffboardedOnlyLogin(p: {
  mustChangePassword: boolean
  visibleCompanyCount: number
  /** In-progress formations + in-progress onboardings (they have their own dashboards). */
  inProgressCount: number
  /** `app_metadata.portal_tier` — the home page shows the formation dashboard for 'formation'. */
  authTier: string
  /** A partner (or a client+partner login) has its own area. */
  isPartnerOrDual: boolean
  closedCompanyCount: number
  offboardingCompanyCount: number
  offerStatus: string | null | undefined
}): boolean {
  if (!p.mustChangePassword) return false
  if (p.visibleCompanyCount > 0) return false
  if (p.inProgressCount > 0) return false
  if (p.authTier === 'formation') return false
  if (p.isPartnerOrDual) return false
  if (p.closedCompanyCount > 0) return false
  return showOffboardingCompanyNotice({ offboardingCompanyCount: p.offboardingCompanyCount, offerStatus: p.offerStatus })
}

/**
 * The status of the login's newest non-expired offer — found the way the portal home finds it (by the login's email, else through the
 * lead with that email), because that status decides whether the person is buying something new.
 */
export async function getLatestOfferStatusForLogin(email: string | null | undefined): Promise<string | null> {
  if (!email) return null
  const { data: offer } = await supabaseAdmin
    .from('offers')
    .select('status')
    .in('client_email', [email])
    .not('status', 'eq', 'expired')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (offer) return (offer.status as string | null) ?? null
  const { data: leads } = await supabaseAdmin.from('leads').select('id').in('email', [email]).limit(1)
  if (!leads?.length) return null
  const { data: leadOffer } = await supabaseAdmin
    .from('offers')
    .select('status')
    .eq('lead_id', leads[0].id)
    .not('status', 'eq', 'expired')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (leadOffer?.status as string | null | undefined) ?? null
}

/**
 * Server side: the offboarded company names when this login is an offboarded-only login that never set a password, else null.
 * Cheap for everyone else: a login that has set its password (nearly everyone), or has a visible company, returns before any query.
 */
export async function resolveOffboardedOnlyScreen(p: {
  email: string | null | undefined
  contactId: string | null | undefined
  mustChangePassword: boolean
  visibleCompanyCount: number
  inProgressCount: number
  authTier: string
  isPartnerOrDual: boolean
}): Promise<{ companyNames: string[] } | null> {
  if (!p.contactId || !p.mustChangePassword || p.visibleCompanyCount > 0 || p.inProgressCount > 0 || p.authTier === 'formation' || p.isPartnerOrDual) return null
  const [offboardingNames, closedNames, offerStatus] = await Promise.all([
    getOffboardingCompanyNames(p.contactId),
    getClosedCompanyNames(p.contactId),
    getLatestOfferStatusForLogin(p.email),
  ])
  const applies = isOffboardedOnlyLogin({
    mustChangePassword: p.mustChangePassword,
    visibleCompanyCount: p.visibleCompanyCount,
    inProgressCount: p.inProgressCount,
    authTier: p.authTier,
    isPartnerOrDual: p.isPartnerOrDual,
    closedCompanyCount: closedNames.length,
    offboardingCompanyCount: offboardingNames.length,
    offerStatus,
  })
  return applies ? { companyNames: offboardingNames } : null
}
