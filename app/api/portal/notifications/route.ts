import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/notifications?account_id=xxx&limit=20
 * GET /api/portal/notifications?contact_id=xxx&limit=20
 * POST /api/portal/notifications (mark as read) Body: { ids: [...] }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const contactIdParam = searchParams.get('contact_id')
  const limit = Math.min(Number(searchParams.get('limit') ?? '20'), 50)

  if (!accountId && !contactIdParam) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // Verify access. Gate on role==='client' (not contact-id presence) so a
  // teammate (client, no contact id) cannot skip the check.
  const isClientUser = user.app_metadata?.role === 'client'
  const authContactId = getClientContactId(user)
  if (isClientUser && !authContactId) {
    // Teammate (Portal Team Access): only their own account, only with 'announcements'.
    const tmAccountId = await getTeammateScopeOrNull(user, 'announcements')
    if (!tmAccountId || !accountId || accountId !== tmAccountId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  } else if (authContactId) {
    if (accountId) {
      const accountIds = await getClientAccountIds(authContactId)
      if (!accountIds.includes(accountId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
    if (contactIdParam && contactIdParam !== authContactId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  let dataQuery = supabaseAdmin
    .from('portal_notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  let countQuery = supabaseAdmin
    .from('portal_notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  if (accountId) {
    dataQuery = dataQuery.eq('account_id', accountId)
    countQuery = countQuery.eq('account_id', accountId)
  } else if (contactIdParam) {
    dataQuery = dataQuery.eq('contact_id', contactIdParam)
    countQuery = countQuery.eq('contact_id', contactIdParam)
  }

  const [{ data }, { count }] = await Promise.all([dataQuery, countQuery])

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

  // Verify the user owns all notifications before marking as read. Gate on
  // role==='client' so a teammate (no contact id) cannot skip the check.
  const isClientUser = user.app_metadata?.role === 'client'
  const authContactId = getClientContactId(user)
  if (isClientUser && !authContactId) {
    // Teammate: only their account's notifications, only with 'announcements'.
    const tmAccountId = await getTeammateScopeOrNull(user, 'announcements')
    if (!tmAccountId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    const { data: notifs } = await supabaseAdmin
      .from('portal_notifications')
      .select('id, account_id')
      .in('id', ids)
    if (notifs?.some(n => n.account_id !== tmAccountId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  } else if (authContactId) {
    const accountIds = await getClientAccountIds(authContactId)
    const { data: notifs } = await supabaseAdmin
      .from('portal_notifications')
      .select('id, account_id, contact_id')
      .in('id', ids)

    // Check access: notification must belong to one of the client's accounts OR their contact_id
    if (notifs?.some(n =>
      (n.account_id && !accountIds.includes(n.account_id)) &&
      (n.contact_id !== authContactId)
    )) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  await supabaseAdmin
    .from('portal_notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)

  return NextResponse.json({ success: true })
}
