/**
 * Portal Team Access — list + create teammates (account-admin only).
 *   GET  /api/portal/team?account_id=...   → teammates for that company
 *   POST /api/portal/team                  → create a teammate
 * Authorization: requester must be the account admin of the target account.
 */
import { createClient } from '@/lib/supabase/server'
import { assertAccountAdmin, createTeammate, listTeammates } from '@/lib/portal/team/server'
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

  const result = await createTeammate({
    accountId,
    username: String(body.username ?? ''),
    displayName: body.display_name ?? null,
    password: String(body.password ?? ''),
    email: body.email ?? null,
    capabilities: body.capabilities,
    createdByContactId: adminContactId,
    disclaimerAccepted: body.disclaimer_accepted === true,
  })

  if (!result.ok) {
    return NextResponse.json({ error: (result.errors ?? ['Could not create team member']).join('; ') }, { status: 400 })
  }
  return NextResponse.json({ ok: true, team_member_id: result.teamMemberId })
}
