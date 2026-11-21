/**
 * Portal Team Access — edit + remove a teammate (owners and members of the company only).
 *   PATCH  /api/portal/team/[id]   body: { account_id, capabilities?, display_name?, notice_accepted?, notice_version?, notice_text?, owner_password? }
 *          Adding a power needs the owner's confirmation in the same request (the notice + their password): without it the
 *          answer is 409 { needs_confirmation: true } and the screen asks. Taking powers away needs nothing.
 *   DELETE /api/portal/team/[id]   body: { account_id }  → remove for good + ban login
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { assertAccountAdmin, updateTeammate, revokeTeammate, ConfirmationRequiredError } from '@/lib/portal/team/server'
import { ownerActorFromRequest } from '@/lib/portal/team/events'
import { confirmGrant } from '@/lib/portal/team/confirm-request'
import { normalizeCapabilities } from '@/lib/portal/team/capabilities'
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

  const actor = ownerActorFromRequest(adminContactId, request.headers)

  // If the owner sent a confirmation, check it now (the notice is built from the powers the person will have AFTER this change).
  let confirmation = null
  if (body.capabilities !== undefined && (body.notice_accepted !== undefined || body.owner_password !== undefined)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabaseAdmin as any).from('portal_team_members').select('display_name').eq('id', params.id).eq('account_id', accountId).maybeSingle()
    if (!row) return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    const confirmed = await confirmGrant({
      user,
      accountId,
      memberName: row.display_name as string,
      caps: normalizeCapabilities(body.capabilities),
      mode: 'more',
      body,
      ip: actor.ip ?? null,
    })
    if (confirmed.ok === false) return NextResponse.json({ error: confirmed.error }, { status: confirmed.status })
    confirmation = confirmed.confirmation
  }

  try {
    await updateTeammate(params.id, accountId, {
      capabilities: body.capabilities,
      display_name: body.display_name,
    }, actor, confirmation)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof ConfirmationRequiredError) {
      return NextResponse.json({ error: err.message, needs_confirmation: true }, { status: 409 })
    }
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
    await revokeTeammate(params.id, accountId, ownerActorFromRequest(adminContactId, request.headers))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Revoke failed' }, { status: 400 })
  }
}
