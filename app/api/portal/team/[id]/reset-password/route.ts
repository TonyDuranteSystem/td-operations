/**
 * Portal Team Access — owner-managed password reset for a teammate.
 *   POST /api/portal/team/[id]/reset-password   body: { account_id, password }
 */
import { createClient } from '@/lib/supabase/server'
import { assertAccountAdmin, resetTeammatePassword } from '@/lib/portal/team/server'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const accountId = String(body.account_id ?? '')
  const adminContactId = await assertAccountAdmin(user, accountId)
  if (!adminContactId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    await resetTeammatePassword(params.id, accountId, String(body.password ?? ''))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Reset failed' }, { status: 400 })
  }
}
