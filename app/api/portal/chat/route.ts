import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { createPortalNotification } from '@/lib/portal/notifications'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/chat?account_id=xxx&before=timestamp&limit=50
 * Returns messages for the given account. Verifies access.
 *
 * POST /api/portal/chat
 * Sends a message. Body: { account_id, message }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const before = searchParams.get('before')
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100)

  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  // Verify access
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(accountId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  let query = supabaseAdmin
    .from('portal_messages')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) {
    query = query.lt('created_at', before)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ messages: (data ?? []).reverse() })
}

export async function POST(request: NextRequest) {
  // Rate limit: 30 messages per minute per IP
  const rl = checkRateLimit(getRateLimitKey(request), 30, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many messages. Slow down.' }, { status: 429 })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, message, attachment_url, attachment_name } = body

  if (!account_id || (!message?.trim() && !attachment_url)) {
    return NextResponse.json({ error: 'account_id and message (or attachment) required' }, { status: 400 })
  }

  // Determine sender type
  const isClientUser = user.app_metadata?.role === 'client'
  const senderType = isClientUser ? 'client' : 'admin'

  // Verify access for clients
  if (isClientUser) {
    const contactId = getClientContactId(user)
    if (contactId) {
      const accountIds = await getClientAccountIds(contactId)
      if (!accountIds.includes(account_id)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
  }

  const { data, error } = await supabaseAdmin
    .from('portal_messages')
    .insert({
      account_id,
      sender_type: senderType,
      sender_id: user.id,
      message: (message || '').trim(),
      attachment_url: attachment_url || null,
      attachment_name: attachment_name || null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Notify client when admin sends a message
  if (senderType === 'admin') {
    createPortalNotification({
      account_id,
      type: 'chat',
      title: 'New message from Tony Durante Team',
      body: (message || '').trim().slice(0, 100),
      link: '/portal/chat',
    }).catch(() => {}) // fire-and-forget
  }

  return NextResponse.json({ message: data })
}
