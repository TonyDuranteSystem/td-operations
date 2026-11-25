import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { decideOwnerForMark, ownerPickerMembers } from '@/lib/portal-chats/waiting-owner'

/**
 * POST /api/portal/chat/waiting-owner — Admin/staff only.
 * Change who a "Waiting on us" conversation belongs to WITHOUT restarting its clock (the days waited, and the mark itself, stay as they are).
 *
 * Body: { account_id?: string, contact_id?: string, assigned_to: string | null }
 * assigned_to = a team member's user id, or null for "not assigned". Exactly one of account_id / contact_id names the conversation.
 * Only a conversation that is currently marked "waiting on us" can be given an owner; anything else answers 404.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  let body: { account_id?: string | null; contact_id?: string | null; assigned_to?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const accountId = body.account_id || null
  const contactId = accountId ? null : (body.contact_id || null)
  if (!accountId && !contactId) return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  if (body.assigned_to === undefined) return NextResponse.json({ error: 'assigned_to required (a team member, or null for nobody)' }, { status: 400 })

  const { listTeamMembers } = await import('@/lib/team/directory')
  let staffIds: string[]
  try {
    staffIds = ownerPickerMembers(await listTeamMembers()).map(m => m.id)
  } catch {
    return NextResponse.json({ error: 'Could not read the team list. Please try again.' }, { status: 500 })
  }
  const decision = decideOwnerForMark({ kind: 'us', requested: body.assigned_to, markerId: user.id, staffIds })
  if (!decision.ok) return NextResponse.json({ error: decision.error ?? 'Could not set who answers.' }, { status: 400 })

  // New table / new column — not in generated types (same cast as waiting-thread).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabaseAdmin as any).from('portal_chat_waiting_threads').update({ assigned_to: decision.owner }).eq('kind', 'us')
  q = accountId ? q.eq('account_id', accountId) : q.eq('contact_id', contactId as string)
  const { data, error } = await q.select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'This conversation is no longer marked "Waiting on us".' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, assigned_to: decision.owner })
}
