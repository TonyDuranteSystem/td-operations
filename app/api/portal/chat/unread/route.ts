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

  // Find the most recent client message in this thread.
  // For contact-scoped threads: check both contact_id-tagged messages AND
  // legacy account-only messages (contact_id=NULL + linked account_id).
  let latestId: string | null = null
  let findError = null

  if (account_id) {
    const { data, error } = await supabaseAdmin
      .from('portal_messages')
      .select('id')
      .eq('account_id', account_id)
      .eq('sender_type', 'client')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    latestId = data?.id ?? null
    findError = error
  } else {
    // Get linked account IDs for this contact
    const { data: acRows } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contact_id)
    const linkedAccountIds = (acRows ?? []).map(r => r.account_id)

    // Check contact-tagged messages first (most recent)
    const { data: d1, error: e1 } = await supabaseAdmin
      .from('portal_messages')
      .select('id, created_at')
      .eq('contact_id', contact_id)
      .eq('sender_type', 'client')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    findError = e1

    // Check legacy account-only messages
    let d2: { id: string; created_at: string } | null = null
    if (linkedAccountIds.length > 0) {
      const { data, error: e2 } = await supabaseAdmin
        .from('portal_messages')
        .select('id, created_at')
        .is('contact_id', null)
        .in('account_id', linkedAccountIds)
        .eq('sender_type', 'client')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      d2 = data
      if (!findError) findError = e2
    }

    // Pick whichever is more recent
    if (d1 && d2) {
      latestId = new Date(d1.created_at) >= new Date(d2.created_at) ? d1.id : d2.id
    } else {
      latestId = d1?.id ?? d2?.id ?? null
    }
  }

  const latest = latestId ? { id: latestId } : null

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
