/**
 * Switch a team login OFF or back ON from the CRM (Team Powers step 5) — STAFF ONLY, SILENT.
 *   POST /api/accounts/[id]/team/[teamMemberId]/switch   body: { action: 'off' | 'on', reason?: string }
 * A reason is required to switch OFF. The change is written to the unchangeable team record with the staff login's email.
 * NO email or message goes to anyone. A person TD switched off cannot be switched on by the owner (that rule lives in switch.ts).
 * The person must belong to THIS company (the company id in the address is part of every lookup).
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { switchTeammateOff, switchTeammateOn } from '@/lib/portal/team/server'
import { tdActorFromRequest } from '@/lib/portal/team/events'
import { TeamSwitchError } from '@/lib/portal/team/switch'

export async function POST(request: NextRequest, { params }: { params: { id: string; teamMemberId: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { data: { user } } = await createClient().auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { action?: unknown; reason?: unknown }
  if (body.action !== 'off' && body.action !== 'on') {
    return NextResponse.json({ error: 'Say whether to switch the person off or on.' }, { status: 400 })
  }

  const actor = tdActorFromRequest(user.email, request.headers)
  try {
    if (body.action === 'off') await switchTeammateOff(params.teamMemberId, params.id, actor, body.reason)
    else await switchTeammateOn(params.teamMemberId, params.id, actor)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof TeamSwitchError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not switch the person.' }, { status: 500 })
  }
}
