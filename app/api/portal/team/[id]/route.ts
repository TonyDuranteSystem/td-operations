/**
 * Portal Team Access — edit + revoke a teammate (account-admin only).
 *   PATCH  /api/portal/team/[id]   body: { account_id, capabilities?, email?, display_name? }
 *   DELETE /api/portal/team/[id]   body: { account_id }  → revoke + ban login
 */
import { createClient } from '@/lib/supabase/server'
import { assertAccountAdmin, updateTeammate, revokeTeammate } from '@/lib/portal/team/server'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const accountId = String(body.account_id ?? '')
  const adminContactId = await assertAccountAdmin(user, accountId)
  if (!adminContactId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    await updateTeammate(params.id, accountId, {
      capabilities: body.capabilities,
      email: body.email,
      display_name: body.display_name,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Update failed' }, { status: 400 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const accountId = String(body.account_id ?? '')
  const adminContactId = await assertAccountAdmin(user, accountId)
  if (!adminContactId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    await revokeTeammate(params.id, accountId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Revoke failed' }, { status: 400 })
  }
}
