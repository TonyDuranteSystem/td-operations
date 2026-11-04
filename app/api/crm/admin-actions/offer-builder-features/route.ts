/**
 * GET /api/crm/admin-actions/offer-builder-features?lead_id=&account_id=&contact_id=&token=
 *
 * Staff only. READ-ONLY. The offer screens ask this which NEW offer-builder pieces they may show for the record they are
 * about (offer builder rollout, dev job d2971d11): `{ addService: boolean, sendCheckBox: boolean }`. The decision is made
 * here, on the server, from the stored settings (off / test / on — set by Claude on Antonio's word, no screen) and, for a
 * piece set to "test", from whether the record is marked as a test record. See lib/offers/rollout.ts and
 * lib/offers/rollout-server.ts.
 *
 * Lives under /api/crm (a session is required) and NOT under /api/offers (a public prefix in the middleware).
 *
 * Answers: 401 not signed in · 403 not staff · 200 { addService, sendCheckBox } · 500 { error } (the screens treat any
 * non-200 as "show nothing"). Never cached.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { offerBuilderFeaturesFor } from '@/lib/offers/rollout-server'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  if (!isStaffUser(user)) return NextResponse.json({ error: 'Staff access required' }, { status: 403, headers: NO_STORE })

  const q = req.nextUrl.searchParams
  try {
    const features = await offerBuilderFeaturesFor({
      leadId: q.get('lead_id'),
      accountId: q.get('account_id'),
      contactId: q.get('contact_id'),
      token: q.get('token'),
    })
    return NextResponse.json(features, { headers: NO_STORE })
  } catch (e) {
    return NextResponse.json({ error: `Could not read the offer-builder settings (${e instanceof Error ? e.message : String(e)})` }, { status: 500, headers: NO_STORE })
  }
}
