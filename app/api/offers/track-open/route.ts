import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/track-open — count a client opening their offer (N0, dev job f907220c).
 *
 * Body: { token, code }. Same behaviour the pages had in the browser: view_count + 1,
 * viewed_at = now, and a draft/sent/published offer becomes 'viewed' (a signed or
 * completed offer keeps its status but still counts the view). Never counts a staff
 * preview. Best-effort: the page does not wait on it.
 */
export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r, { offerColumns: 'id, token, access_code, status, view_count', clientAction: true })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })
  if (access.kind !== 'offer') return NextResponse.json({ ok: true, skipped: 'not_an_offer' })
  if (access.staffPreview) return NextResponse.json({ ok: true, skipped: 'staff_preview' })

  const o = access.offer
  const now = new Date().toISOString()
  const { error } = await supabaseAdmin
    .from('offers')
    .update({ view_count: (o.view_count || 0) + 1, viewed_at: now })
    .eq('id', o.id)
  if (error) return NextResponse.json({ error: 'Could not record the view.' }, { status: 500 })
  // Only an unopened offer becomes 'viewed' — conditionally, so a view recorded at the
  // same moment as a signature can never turn a signed offer back to 'viewed'.
  await supabaseAdmin
    .from('offers')
    .update({ status: 'viewed' })
    .eq('id', o.id)
    .in('status', ['draft', 'sent', 'published'])
  return NextResponse.json({ ok: true })
}
