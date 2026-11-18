/**
 * Portal Team Access — list + create teammates (account-admin only).
 *   GET  /api/portal/team?account_id=...   → teammates for that company
 *   POST /api/portal/team                  → create a teammate
 * Authorization: requester must be the account admin of the target account.
 */
import { createClient } from '@/lib/supabase/server'
import { assertAccountAdmin, createTeammate, listTeammates } from '@/lib/portal/team/server'
import { ownerActorFromRequest } from '@/lib/portal/team/events'
import { confirmGrant } from '@/lib/portal/team/confirm-request'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = new URL(request.url).searchParams.get('account_id') ?? ''
  const adminContactId = await assertAccountAdmin(user, accountId)
  if (!adminContactId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const teammates = await listTeammates(accountId)
  return NextResponse.json({ teammates })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const accountId = String(body.account_id ?? '')
  const adminContactId = await assertAccountAdmin(user, accountId)
  if (!adminContactId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Giving someone access needs the owner's confirmation IN THIS REQUEST: the notice they read and accepted, and their password.
  const ip = ownerActorFromRequest(adminContactId, request.headers).ip
  const confirmed = await confirmGrant({
    user,
    accountId,
    memberName: String(body.display_name ?? ''),
    caps: body.capabilities,
    mode: 'add',
    body,
    ip,
  })
  if (confirmed.ok === false) return NextResponse.json({ error: confirmed.error }, { status: confirmed.status })

  const result = await createTeammate({
    accountId,
    username: body.username ? String(body.username) : null,
    displayName: String(body.display_name ?? ''),
    capabilities: body.capabilities,
    createdByContactId: adminContactId,
    disclaimerAccepted: true, // the accepted notice is the acceptance
    noticeVersion: confirmed.confirmation.version,
    noticeText: confirmed.confirmation.text,
    ip,
  })

  if (!result.ok) {
    return NextResponse.json({ error: (result.errors ?? ['Could not create team member']).join('; ') }, { status: 400 })
  }
  // The password is shown to the owner ONCE (handover message); it is never stored in readable form.
  return NextResponse.json({ ok: true, team_member_id: result.teamMemberId, username: result.username, password: result.password })
}
