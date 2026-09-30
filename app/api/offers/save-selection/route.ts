import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { validateSelection, SIGNABLE_OFFER_STATUSES } from '@/lib/offers/public-signing'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/save-selection — store which optional services the client ticked,
 * BEFORE the contract page opens (N0, dev job f907220c).
 *
 * Body: { token, code, selected_services: string[] } — every required line plus the
 * ticked optional ones, the exact list the page has always stored. The contract page
 * renders and prices from this stored list; if it were lost, an empty list would mean
 * "every optional line", so the page waits for this call and shows its error.
 *
 * Refused once the offer can no longer be signed (a signed offer's selection IS the
 * contract — the checkout route relies on that), and for names that are not lines of
 * this offer.
 */
export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r, { offerColumns: 'id, token, access_code, status, services' })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })
  if (access.kind !== 'offer') return NextResponse.json({ error: 'Not an offer.' }, { status: 400 })

  const o = access.offer
  if (!(SIGNABLE_OFFER_STATUSES as readonly string[]).includes(String(o.status))) {
    return NextResponse.json({ error: 'This offer can no longer be changed.' }, { status: 409 })
  }
  const selection = validateSelection(o, r.body.selected_services)
  if (!selection) return NextResponse.json({ error: 'Invalid selection.' }, { status: 400 })

  const { error } = await supabaseAdmin
    .from('offers')
    .update({ selected_services: selection })
    .eq('id', o.id)
    .in('status', SIGNABLE_OFFER_STATUSES as unknown as string[])
  if (error) return NextResponse.json({ error: 'Could not save your choice. Please try again.' }, { status: 500 })
  return NextResponse.json({ ok: true, selected_services: selection })
}
