import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/read
 * Marks messages as read.
 * - Admin calling: marks client messages as read (admin has seen them)
 * - Client calling: marks admin messages as read (client has seen them)
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { account_id } = await request.json()
  if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  const dashUser = isDashboardUser(user)

  // Verify access for clients
  if (!dashUser) {
    const contactId = getClientContactId(user)
    if (contactId) {
      const accountIds = await getClientAccountIds(contactId)
      if (!accountIds.includes(account_id)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
  }

  // Mark opposite sender's messages as read
  const senderTypeToMark = dashUser ? 'client' : 'admin'

  const { error, count } = await supabaseAdmin
    .from('portal_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('account_id', account_id)
    .eq('sender_type', senderTypeToMark)
    .is('read_at', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ marked: count ?? 0 })
}
