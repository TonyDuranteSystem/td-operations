import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/notifications?account_id=xxx&limit=20
 * POST /api/portal/notifications (mark as read) Body: { ids: [...] }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const limit = Math.min(Number(searchParams.get('limit') ?? '20'), 50)

  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(accountId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  const { data } = await supabaseAdmin
    .from('portal_notifications')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit)

  const { count } = await supabaseAdmin
    .from('portal_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('read_at', null)

  return NextResponse.json({ notifications: data ?? [], unread_count: count ?? 0 })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { ids } = body

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }

  // Verify client owns all notifications before marking as read
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    const { data: notifs } = await supabaseAdmin
      .from('portal_notifications')
      .select('id, account_id')
      .in('id', ids)

    if (notifs?.some(n => !accountIds.includes(n.account_id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  await supabaseAdmin
    .from('portal_notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)

  return NextResponse.json({ success: true })
}
