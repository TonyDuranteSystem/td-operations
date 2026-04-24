import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/unread
 * Admin only: marks ONLY the most recent client message in a thread as unread
 * (resets read_at to null). Used when admin reads a message but wants to come
 * back to it later. Older messages in the thread keep their read_at untouched —
 * only the latest one drives the unread badge count.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const { account_id, contact_id } = await request.json()
  if (!account_id && !contact_id) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // Find the most recent client message in this thread
  let query = supabaseAdmin
    .from('portal_messages')
    .select('id')
    .eq('sender_type', 'client')
    .order('created_at', { ascending: false })
    .limit(1)

  if (account_id) {
    query = query.eq('account_id', account_id)
  } else {
    query = query.eq('contact_id', contact_id).is('account_id', null)
  }

  const { data: latest, error: findError } = await query.maybeSingle()

  if (findError) return NextResponse.json({ error: findError.message }, { status: 500 })
  if (!latest) return NextResponse.json({ unmarked: 0 })

  // Reset read_at on just that single message
  const { error } = await supabaseAdmin
    .from('portal_messages')
    .update({ read_at: null })
    .eq('id', latest.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ unmarked: 1 })
}
