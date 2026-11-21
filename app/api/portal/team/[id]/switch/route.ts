/**
 * Portal Team Access — switch a team member off or back on (reversible; "Remove" is for good).
 *   POST /api/portal/team/[id]/switch   body: { account_id, action: 'off' | 'on', reason? }
 * Owners and members of the company only. If Tony Durante LLC switched the person off, the owner cannot switch them on.
 * Switching on gives access back, so it is recorded strictly; switching off is never blocked by a failing record.
 */
import { createClient } from '@/lib/supabase/server'
import { assertAccountAdmin, switchTeammateOff, switchTeammateOn } from '@/lib/portal/team/server'
import { ownerActorFromRequest } from '@/lib/portal/team/events'
import { TeamSwitchError } from '@/lib/portal/team/switch'
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
  if (body.action !== 'off' && body.action !== 'on') {
    return NextResponse.json({ error: 'Say whether to switch the person off or on.' }, { status: 400 })
  }

  const actor = ownerActorFromRequest(adminContactId, request.headers)
  try {
    if (body.action === 'off') await switchTeammateOff(params.id, accountId, actor, body.reason)
    else await switchTeammateOn(params.id, accountId, actor)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof TeamSwitchError) {
      const status = err.code === 'td_locked' ? 403 : err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not switch the person' }, { status: 500 })
  }
}
