import { NextRequest, NextResponse } from 'next/server'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { toPublicOfferView, toPublicRenewalView } from '@/lib/offers/public-offer-view'
import { signRenewalPass } from '@/lib/offers/renewal-pass'
import { multiAgreementsEnabled } from '@/lib/offers/multi-agreements-switch'
import { isStandaloneAgreementType } from '@/lib/offers/standalone-contract-types'
import { customTypesOnOffer, ensureOfferContractTexts, untypedServiceNames } from '@/lib/offers/contract-texts-snapshot'
import { alertMissingContractWording } from '@/lib/offers/contract-wording-alert'

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
  const view: Record<string, unknown> = { ...toPublicOfferView(access.offer), multi_agreements }

  // An offer that sells a NEW service renders that service's wording from the frozen copy on the offer. It is taken
  // when the offer is sent; if it is missing (a path that sends without it), take it now — the first time a page asks.
  // If no approved wording exists the page shows its "being prepared" notice and staff are told (never a wrong contract).
  const row = access.offer as { token?: string; status?: unknown; contract_type?: unknown; services?: unknown; packages?: unknown }
  const needsWording = customTypesOnOffer({ contractType: row.contract_type, services: row.services, packages: row.packages }).length > 0
    || untypedServiceNames({ services: row.services, packages: row.packages }).length > 0 // built before the service had its contract
  // What this page may do with the frozen copy:
  //  - a STAFF preview of a DRAFT shows today's approved wording and stores nothing (the wording is frozen at the real send);
  //  - a CLIENT looking at a draft (the portal shows drafts as "Proposal ready", and a draft can be signed) is client-facing
  //    like any other: the copy is taken now, because nothing else will take it before they sign;
  //  - sent / viewed: completed here (never replaced);
  //  - signed, paid, active …: NEVER touched — what the client signed stays exactly as it was.
  const status = String(row.status ?? '')
  const mode = status === 'draft' && access.staffPreview ? 'preview' : status === 'draft' || status === 'sent' || status === 'viewed' ? 'complete' : 'leave'
  if (needsWording && row.token && mode !== 'leave') {
    try {
      const frozen = await ensureOfferContractTexts(row.token, { persist: mode === 'complete' })
      view.contract_texts = frozen.texts
      if (frozen.lines) {
        // the service lines just got their contract type: the page must plan its agreements from the corrected lines
        if ('services' in view) view.services = frozen.lines.services
        if ('packages' in view) view.packages = frozen.lines.packages
      }
      if (frozen.missing.length > 0 && !access.staffPreview) await alertMissingContractWording(row.token, frozen.missing)
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      console.warn('[offers/view] could not prepare the contract wording:', why)
      // the client sees "being prepared": staff must hear about it too, not only the log
      if (!access.staffPreview) {
        await alertMissingContractWording(row.token, customTypesOnOffer({ contractType: row.contract_type, services: row.services, packages: row.packages }), why)
      }
    }
  }

  return NextResponse.json({
    kind: 'offer',
    offer: view,
    staffPreview: access.staffPreview,
  })
}
