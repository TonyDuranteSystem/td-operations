import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { getPartnerEarnings, resolveDefaultCommWorker } from '@/lib/td-communication/revenue-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/earnings — the caller's TD Communication earnings +
 * two-stage balance + payout history. Partner → their own worker id (no IDOR,
 * never trusts the body). Staff → the single default worker. NO client-price data.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const workerId = participant.type === 'partner' ? participant.id : await resolveDefaultCommWorker()
    const earnings = await getPartnerEarnings(workerId)
    return NextResponse.json({ earnings })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load earnings.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
