import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/chat/badge
 * Admin only: returns count of client portal messages since admin last visited /portal-chats.
 * Uses the portal_chats_last_seen cookie (set by the browser) instead of read_at IS NULL
 * so it works even if the read_at column doesn't exist in the DB.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ count: 0 })
  }

  const cookieStore = cookies()
  const lastSeenCookie = cookieStore.get('portal_chats_last_seen')?.value
  // Default: last 30 days when admin has never visited portal-chats
  const lastSeen = lastSeenCookie ?? new Date(Date.now() - 30 * 86400000).toISOString()

  const { count, error } = await supabaseAdmin
    .from('portal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_type', 'client')
    .gt('created_at', lastSeen)

  if (error) {
    console.error('[portal/chat/badge] query error:', error)
    return NextResponse.json({ count: 0 })
  }

  return NextResponse.json({ count: count ?? 0 })
}
