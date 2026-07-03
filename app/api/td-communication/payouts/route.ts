import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { createTdCommPayoutRequest } from '@/lib/td-communication/revenue-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/payouts — the partner (Cris) requests a payout.
 * Body: { amount, note? }. The partner id is derived from the authenticated
 * participant (never the body). Overdraw → 422. Staff use the admin flow, so
 * this is partner-only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (participant.type !== 'partner') {
    return NextResponse.json({ error: 'Only the partner can request a payout.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const amount = Number((body as { amount?: unknown })?.amount)
  const noteRaw = (body as { note?: unknown })?.note
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : null
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'A positive amount is required.' }, { status: 400 })
  }

  try {
    const isTest = process.env.SANDBOX_MODE === '1'
    const result = await createTdCommPayoutRequest(participant.id, amount, note, isTest)
    return NextResponse.json({ ok: true, id: result.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to request payout.'
    // Overdraw / validation → 422 so the client surfaces the reason (R099).
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
