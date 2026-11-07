/**
 * POST /api/flows/[id]/return-fax/check — "Check now" on the Tax Return fax box (plan item 6).
 *
 * Runs the SAME delivery check the cron runs every few minutes (lib/fax/return-fax-delivery.ts) for this one job: asks Faxage about the job's latest
 * return fax and, when it was delivered, saves the receipt and files the job. Idempotent (a second click, or the cron at the same moment, does nothing
 * twice). Staff-only. [id] = service_delivery_id. Returns `{ success, result }`; the box then reloads its state.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { processReturnFaxDelivery, realReturnFaxDeps } from '@/lib/fax/return-fax-delivery'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  const result = await processReturnFaxDelivery(params.id, await realReturnFaxDeps())
  if (result.outcome === 'error') {
    return NextResponse.json({ success: false, result, error: `Could not check the fax: ${result.error}` }, { status: 502 })
  }
  return NextResponse.json({ success: true, result })
}
