import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/pin-thread — Admin/staff only.
 * Pin or unpin a CONVERSATION in the CRM Portal Chats list. Shared across the
 * team (one row per thread). Pinned conversations sort above everything.
 *
 * Body: { account_id?: string, contact_id?: string, pinned: boolean }
 * Exactly one of account_id / contact_id identifies the thread.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  let body: { account_id?: string | null; contact_id?: string | null; pinned?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const accountId = body.account_id || null
  const contactId = body.contact_id || null
  const pinned = body.pinned === true

  if (!accountId && !contactId) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // portal_chat_pinned_threads is a new table — not in generated types until the
  // migration is promoted to prod and types regenerate. Cast bypasses that, per
  // the codebase pattern (see threads route's (supabaseAdmin as any).rpc).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pins = (supabaseAdmin as any).from('portal_chat_pinned_threads')

  if (pinned) {
    // Idempotent insert. We do NOT use upsert/onConflict: the unique indexes are
    // PARTIAL (WHERE ... IS NOT NULL), which PostgREST can't target as an
    // ON CONFLICT spec. Instead insert and treat a unique violation (23505 —
    // already pinned) as success. The partial index still blocks real duplicates.
    const { error } = await pins.insert({
      account_id: accountId,
      contact_id: accountId ? null : contactId,
      pinned_by: user.id,
    })
    if (error && error.code !== '23505') {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, pinned: true })
  }

  // Unpin
  let del = pins.delete()
  del = accountId ? del.eq('account_id', accountId) : del.eq('contact_id', contactId as string)
  const { error } = await del
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, pinned: false })
}
