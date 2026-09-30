/**
 * GET /api/crm/offer-preview?token=<offerToken>
 *
 * Staff "View offer" from the CRM (N0, dev job f907220c). Proves staff identity here
 * (admin/team — isStaffUser, never a partner or client), looks up the offer's access code,
 * mints a 30-minute preview pass bound to this offer, and redirects to the offer page on
 * the SAME host. The pass lets the offer routes treat the visit as a staff preview: no
 * email gate, and the view is NOT counted (a staff look must never flip an offer to
 * "viewed"). Replaces the CRM links that relied on the bare `?preview=td` flag, which the
 * offer pages no longer trust.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { signOfferPreviewPass } from '@/lib/offers/offer-preview-pass'

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !isStaffUser(data?.user ?? null)) {
    return NextResponse.json({ error: 'Staff only' }, { status: 403 })
  }

  const token = req.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 })

  const { data: offer } = await supabaseAdmin
    .from('offers')
    .select('token, access_code')
    .eq('token', token)
    .maybeSingle()
  if (!offer?.access_code) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })

  const pass = await signOfferPreviewPass(offer.token, data!.user!.id)
  const target = new URL(
    `/offer/${encodeURIComponent(offer.token)}/${encodeURIComponent(String(offer.access_code))}?preview=td&pass=${encodeURIComponent(pass)}`,
    req.nextUrl.origin,
  )
  return NextResponse.redirect(target, 302)
}
