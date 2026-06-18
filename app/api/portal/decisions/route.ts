/**
 * GET /api/portal/decisions?sd_id=xxx — list all decision requests for a
 * service delivery (workspace history). Staff-only.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { listDecisionRequestsForSd } from '@/lib/operations/decision-request'

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const role = (user.app_metadata as Record<string, unknown> | undefined)?.role
  if (role === 'client') {
    return NextResponse.json({ success: false, error: 'Staff access required' }, { status: 403 })
  }

  const sdId = new URL(req.url).searchParams.get('sd_id')
  if (!sdId) return NextResponse.json({ success: false, error: 'Missing sd_id' }, { status: 400 })

  const requests = await listDecisionRequestsForSd(sdId)
  return NextResponse.json({ success: true, requests })
}
