import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/unread
 * Admin only: marks client messages in a thread as unread (resets read_at to null).
 * Used when admin reads a message but wants to come back to it later.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const { account_id } = await request.json()
  if (!account_id) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // Reset read_at on client messages for this thread
  const { error, count } = await supabaseAdmin
    .from('portal_messages')
    .update({ read_at: null })
    .eq('account_id', account_id)
    .eq('sender_type', 'client')
    .not('read_at', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ unmarked: count ?? 0 })
}
