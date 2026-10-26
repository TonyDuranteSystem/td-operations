import { NextRequest, NextResponse } from 'next/server'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { toPublicOfferView, toPublicRenewalView } from '@/lib/offers/public-offer-view'
import { signRenewalPass } from '@/lib/offers/renewal-pass'
import { multiAgreementsEnabled } from '@/lib/offers/multi-agreements-switch'
import { isStandaloneAgreementType } from '@/lib/offers/standalone-contract-types'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/view — the offer (or renewal agreement) as the client's pages see it.
 * N0, dev job f907220c: replaces the pages' direct `select('*')` with the public key.
 *
 * Body: { token, code } for an offer; { token, pass } for a renewal agreement;
 * { token, preview: 'td' } for a real staff session.
 *
 * Returns { kind, offer, staffPreview, grant? }. The row is filtered through
 * toPublicOfferView — never the access code, commissions, partner terms, notes or
 * CRM links. For a renewal, `grant` is a 4-hour pass the page keeps in memory for its
 * later calls (the portal's handoff pass only lives 2 minutes).
 */
export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r)
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.kind === 'renewal') {
    const grant = access.staffPreview
      ? null
      : await signRenewalPass({ agreementId: String(access.agreement.id), kind: 'grant' })
    return NextResponse.json({
      kind: 'renewal',
      offer: toPublicRenewalView(access.agreement),
      staffPreview: access.staffPreview,
      grant,
    })
  }

  // Flexible-offer slice 2: the switch for "several agreements in one short contract, signed once".
  // OFF by default; a staff preview always sees it ON so it can be tested before clients get it.
  // Only short-contract offers use it — formation / onboarding never read the setting.
  const multi_agreements = isStandaloneAgreementType((access.offer as { contract_type?: unknown } | null)?.contract_type)
    ? await multiAgreementsEnabled({ staffPreview: access.staffPreview })
    : false
  return NextResponse.json({
    kind: 'offer',
    offer: { ...toPublicOfferView(access.offer), multi_agreements },
    staffPreview: access.staffPreview,
  })
}
