import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { decideOwnerForMark, ownerPickerMembers } from '@/lib/portal-chats/waiting-owner'

/**
 * POST /api/portal/chat/waiting-thread — Admin/staff only.
 * Mark or clear "waiting for client" on a CONVERSATION in the CRM Portal Chats list. Shared across
 * the team (one row per conversation, same keys as pin-thread). The mark ends by itself when the
 * client writes after it (decided when the list is read — see lib/portal-chats/waiting.ts).
 *
 * Body: { account_id?: string, contact_id?: string, waiting: boolean, kind?: 'client' | 'us', assigned_to?: string | null }
 * Exactly one of account_id / contact_id identifies the conversation.
 * kind 'client' (default) = waiting for the client; 'us' = the client is waiting for us (ends when staff write).
 * assigned_to (either kind): the team member who answers ('us') or follows the client up ('client'). Left out = the person marking; null = nobody yet
 * (see lib/portal-chats/waiting-owner.ts). Before 2026-11-25 (later) only 'us' had an owner.
 * One mark per conversation: marking replaces any existing mark, of either kind, and restarts the clock
 * (new marked_at, reminders back to zero).
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  let body: { account_id?: string | null; contact_id?: string | null; waiting?: boolean; kind?: string; assigned_to?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const accountId = body.account_id || null
  const contactId = accountId ? null : (body.contact_id || null)
  const waiting = body.waiting === true
  // 'client' = we wait for the client (default, keeps the 3-day reminder); 'us' = the client waits for us.
  const kind = body.kind === 'us' ? 'us' : 'client'
  if (!accountId && !contactId) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // Who a mark belongs to (2026-11-25; both kinds since the "later" change): the person marking it unless the screen asked for someone else (or nobody).
  // Decided BEFORE anything is deleted, so a refused owner leaves the existing mark untouched.
  let owner: string | null = null
  if (waiting) {
    const { listTeamMembers } = await import('@/lib/team/directory')
    let staffIds: string[]
    try {
      staffIds = ownerPickerMembers(await listTeamMembers()).map(m => m.id)
    } catch {
      return NextResponse.json({ error: 'Could not read the team list. Please try again.' }, { status: 500 })
    }
    const decision = decideOwnerForMark({ kind, requested: body.assigned_to, markerId: user.id, staffIds })
    if (!decision.ok) return NextResponse.json({ error: decision.error ?? 'Could not set who answers.' }, { status: 400 })
    owner = decision.owner
  }

  // New table — not in generated types until the migration is promoted and types regenerate (same cast as pin-thread).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waits = (supabaseAdmin as any).from('portal_chat_waiting_threads')

  // Clear (or restart the clock): remove any existing mark for this conversation first.
  let del = waits.delete()
  del = accountId ? del.eq('account_id', accountId) : del.eq('contact_id', contactId as string)
  const { error: delErr } = await del
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  if (!waiting) return NextResponse.json({ ok: true, waiting: false })

  const markedAt = new Date().toISOString()
  const row = { account_id: accountId, contact_id: contactId, marked_by: user.id, marked_at: markedAt, kind }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { error } = await (supabaseAdmin as any).from('portal_chat_waiting_threads').insert({ ...row, assigned_to: owner })
  // 42703 = the owner column is not in this database yet (the code can reach production before its migration): mark without an owner.
  if (error?.code === '42703') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;({ error } = await (supabaseAdmin as any).from('portal_chat_waiting_threads').insert(row))
    owner = null
  }
  // 23505 = a second click raced this one; the conversation is marked either way.
  if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, waiting: true, kind, waiting_since: markedAt, assigned_to: owner })
}
