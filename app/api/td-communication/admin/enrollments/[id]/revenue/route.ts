import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { setPartnerAmount } from '@/lib/td-communication/revenue-queries'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/td-communication/admin/enrollments/[id]/revenue — set Cris's earning
 * for a project. Body: { amount }. Admin-only.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const amount = Number((body as { amount?: unknown })?.amount)
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: 'A non-negative amount is required.' }, { status: 400 })
  }

  try {
    await setPartnerAmount(params.id, amount)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to set amount.'
    return NextResponse.json({ error: message }, { status: message === 'Project not found.' ? 404 : 500 })
  }
}
