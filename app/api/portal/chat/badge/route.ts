import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/chat/badge
 * Admin only: returns total count of unread client portal messages.
 * Used by the CRM sidebar to show the portal chats badge count.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ count: 0 })
  }

  const { count, error } = await supabaseAdmin
    .from('portal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_type', 'client')
    .is('read_at', null)

  if (error) {
    console.error('[portal/chat/badge] query error:', error)
    return NextResponse.json({ count: 0 })
  }

  return NextResponse.json({ count: count ?? 0 })
}
