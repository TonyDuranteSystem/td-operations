import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/waiting-thread — Admin/staff only.
 * Mark or clear "waiting for client" on a CONVERSATION in the CRM Portal Chats list. Shared across
 * the team (one row per conversation, same keys as pin-thread). The mark ends by itself when the
 * client writes after it (decided when the list is read — see lib/portal-chats/waiting.ts).
 *
 * Body: { account_id?: string, contact_id?: string, waiting: boolean, kind?: 'client' | 'us' }
 * Exactly one of account_id / contact_id identifies the conversation.
 * kind 'client' (default) = waiting for the client; 'us' = the client is waiting for us (ends when staff write).
 * One mark per conversation: marking replaces any existing mark, of either kind, and restarts the clock
 * (new marked_at, reminders back to zero).
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  let body: { account_id?: string | null; contact_id?: string | null; waiting?: boolean; kind?: string }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any).from('portal_chat_waiting_threads').insert({
    account_id: accountId,
    contact_id: contactId,
    marked_by: user.id,
    marked_at: markedAt,
    kind,
  })
  // 23505 = a second click raced this one; the conversation is marked either way.
  if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, waiting: true, kind, waiting_since: markedAt })
}
