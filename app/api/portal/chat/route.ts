import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { createPortalNotification } from '@/lib/portal/notifications'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { CRM_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/chat?account_id=xxx&before=timestamp&limit=50
 * GET /api/portal/chat?contact_id=xxx&before=timestamp&limit=50
 * Returns messages for the given account or contact. Verifies access.
 *
 * POST /api/portal/chat
 * Sends a message. Body: { account_id?, contact_id?, message }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const contactIdParam = searchParams.get('contact_id')
  const before = searchParams.get('before')
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100)

  if (!accountId && !contactIdParam) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // Verify access
  const authContactId = getClientContactId(user)
  if (authContactId) {
    if (accountId) {
      const accountIds = await getClientAccountIds(authContactId)
      if (!accountIds.includes(accountId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    } else if (contactIdParam && contactIdParam !== authContactId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  let query = supabaseAdmin
    .from('portal_messages')
    .select('*, contacts:contact_id(full_name)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (accountId) {
    query = query.eq('account_id', accountId)
  } else if (contactIdParam) {
    query = query.eq('contact_id', contactIdParam).is('account_id', null)
  }

  if (before) {
    query = query.lt('created_at', before)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Flatten contact name into sender_name for display
  const messages = (data ?? []).map(msg => {
    const contact = msg.contacts as unknown as { full_name: string } | null
    const { contacts: _contacts, ...rest } = msg
    return {
      ...rest,
      sender_name: contact?.full_name || null,
    }
  }).reverse()

  return NextResponse.json({ messages })
}

export async function POST(request: NextRequest) {
  // Rate limit: 30 messages per minute per IP
  const rl = checkRateLimit(getRateLimitKey(request), 30, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many messages. Slow down.' }, { status: 429 })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, contact_id: bodyContactId, message, attachment_url, attachment_name, reply_to_id } = body

  if (!account_id && !bodyContactId && !getClientContactId(user)) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  if (!message?.trim() && !attachment_url) {
    return NextResponse.json({ error: 'message or attachment required' }, { status: 400 })
  }

  // Input validation: max message length
  if (message && message.length > 5000) {
    return NextResponse.json({ error: 'Message too long (max 5000 characters)' }, { status: 400 })
  }

  // Validate attachment_url is from our storage only
  if (attachment_url && !attachment_url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL || '')) {
    return NextResponse.json({ error: 'Invalid attachment URL' }, { status: 400 })
  }

  // Determine sender type
  const isClientUser = user.app_metadata?.role === 'client'
  const senderType = isClientUser ? 'client' : 'admin'

  // Resolve contact_id — always set (from body, or from auth user)
  const resolvedContactId = bodyContactId || getClientContactId(user)

  // Verify access for clients
  if (isClientUser) {
    const authContactId = getClientContactId(user)
    if (authContactId && account_id) {
      const accountIds = await getClientAccountIds(authContactId)
      if (!accountIds.includes(account_id)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
    // If no account_id, contact_id must match auth user's contact
    if (!account_id && resolvedContactId && resolvedContactId !== authContactId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  const { data, error } = await supabaseAdmin
    .from('portal_messages')
    .insert({
      account_id: account_id || null,
      contact_id: resolvedContactId || null,
      sender_type: senderType,
      sender_id: user.id,
      message: (message || '').trim(),
      attachment_url: attachment_url || null,
      attachment_name: attachment_name || null,
      reply_to_id: reply_to_id || null,
    })
    .select('*, contacts:contact_id(full_name)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Flatten sender_name
  const contact = data.contacts as unknown as { full_name: string } | null
  const { contacts: _contacts, ...msgData } = data
  const responseMsg = { ...msgData, sender_name: contact?.full_name || null }

  // Notify client when admin sends a message
  if (senderType === 'admin') {
    createPortalNotification({
      account_id: account_id || undefined,
      contact_id: resolvedContactId || undefined,
      type: 'chat',
      title: 'New message from Tony Durante Team',
      body: (message || '').trim().slice(0, 100),
      link: '/portal/chat',
    }).catch(() => {})
  }

  // Notify admin when client sends a message
  if (senderType === 'client') {
    notifyAdminOfClientMessage(account_id, resolvedContactId, user.email || '', (message || '').trim()).catch(() => {})
    pushNotifyAdmin(account_id, resolvedContactId, (message || '').trim()).catch(() => {})
  }

  // Audit log
  const { logPortalAction } = await import('@/lib/portal/audit')
  logPortalAction({
    user_id: user.id,
    account_id: account_id || undefined,
    action: 'message_sent',
    detail: `${senderType} message (${(message || '').length} chars)${attachment_url ? ' + attachment' : ''}`,
    ip: request.headers.get('x-forwarded-for') || undefined,
  })

  return NextResponse.json({ message: responseMsg })
}

/**
 * Send email notification to admin when a client sends a chat message.
 * Throttled: only sends if no email was sent for this account in last 5 minutes
 * (to avoid spam when client sends multiple messages).
 */
const recentAdminNotifications = new Map<string, number>()

async function notifyAdminOfClientMessage(accountId: string | null, contactId: string | null, clientEmail: string, messagePreview: string) {
  // Throttle: max 1 email per conversation per 5 minutes
  const throttleKey = accountId || contactId || clientEmail
  const lastSent = recentAdminNotifications.get(throttleKey) ?? 0
  if (Date.now() - lastSent < 5 * 60 * 1000) return
  recentAdminNotifications.set(throttleKey, Date.now())

  // Get display name: company name if account exists, else contact name
  let displayName = 'Unknown'
  if (accountId) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .single()
    displayName = account?.company_name || 'Unknown'
  } else if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', contactId)
      .single()
    displayName = contact?.full_name || 'Unknown'
  }

  const escHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;')
  const companyName = escHtml(displayName)
  const preview = escHtml(messagePreview.slice(0, 200) || '[Attachment]')

  try {
    const { gmailPost } = await import('@/lib/gmail')

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 18px;">💬 New Portal Message</h1>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <p style="margin: 0 0 4px;"><strong>Company:</strong> ${companyName}</p>
          <p style="margin: 0 0 16px; color: #6b7280;"><strong>From:</strong> ${clientEmail}</p>
          <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
            <p style="margin: 0; color: #27272a; font-size: 14px; white-space: pre-wrap;">${preview}</p>
          </div>
          <a href="${CRM_BASE_URL}/portal-chats" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Reply in CRM
          </a>
        </div>
      </div>
    `

    const subject = `Portal: New message from ${companyName}`
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: TD Portal <support@tonydurante.us>`,
      `To: support@tonydurante.us`,
      `Subject: ${encodedSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n')

    await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
  } catch (err) {
    console.error('Admin chat notification email failed:', err)
  }
}

/**
 * Send push notification to all admin devices when a client sends a message.
 */
async function pushNotifyAdmin(accountId: string | null, contactId: string | null, messagePreview: string) {
  let displayName = 'Unknown'
  if (accountId) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .single()
    displayName = account?.company_name || 'Unknown'
  } else if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', contactId)
      .single()
    displayName = contact?.full_name || 'Unknown'
  }

  const { sendPushToAdmin } = await import('@/lib/portal/web-push')
  await sendPushToAdmin({
    title: `Chat: ${displayName}`,
    body: messagePreview.slice(0, 200) || '[Attachment]',
    url: `/portal-chats${accountId ? `?account=${accountId}` : ''}`,
    tag: `admin-chat-${accountId || contactId || 'unknown'}`,
  })
}
