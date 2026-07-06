import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { getTeammateScopeOrNull, requirePortalCapability } from '@/lib/portal/team/gate'
import { pickChatSenderName } from '@/lib/portal/chat-sender-name'
import { createPortalNotification, notifyClientOfAdminMessage } from '@/lib/portal/notifications'
import { isPortalAdminEmailEnabled } from '@/lib/settings'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { CRM_BASE_URL } from '@/lib/config'
import { isOfficeOpen } from '@/lib/portal/office-hours'
import { sendOfficeClosedAutoReply } from '@/lib/portal/auto-reply'
import { buildChatQueryPlan, type ChatQueryPlan } from '@/lib/portal/chat-scope'
import { resolvePersonalNullInclusion } from '@/lib/portal/chat-scope-server'
import { contactThreadOrFilter } from '@/lib/portal/thread-scope'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/chat?account_id=xxx&before=timestamp&limit=50
 * GET /api/portal/chat?contact_id=xxx&before=timestamp&limit=50
 * Returns messages for the given account or contact. Verifies access.
 *
 * Threading model (PR 2 Step 6, 2026-05-05):
 * - When contact_id is given: returns ALL messages for the contact across
 *   both scopes (account_id NULL or set). This is the unified thread the
 *   client sees in the portal — one tagged thread per contact.
 * - When account_id is given (and contact_id is not): returns messages
 *   for that account only. Used by the CRM admin viewer which still
 *   groups by account.
 *
 * POST /api/portal/chat
 * Sends a message. Body: { account_id?, contact_id?, sender_context?, message }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const contactIdParam = searchParams.get('contact_id')
  const scope = searchParams.get('scope') // 'company' | 'personal' (client per-company scoping) | absent (legacy/admin)
  const before = searchParams.get('before')
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100)

  if (!accountId && !contactIdParam) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // Verify access. NOTE: gate on role==='client', NOT on contact-id presence —
  // a teammate is a client with NO contact id and must never fall into the
  // admin branch below.
  const isClientUser = user.app_metadata?.role === 'client'
  const authContactId = getClientContactId(user)
  let clientAccountIds: string[] = []

  if (isClientUser && !authContactId) {
    // Teammate (Portal Team Access): may ONLY read their own account's thread,
    // and only if granted 'chat'.
    const tmAccountId = await getTeammateScopeOrNull(user, 'chat')
    if (!tmAccountId || !accountId || accountId !== tmAccountId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  } else if (authContactId) {
    if (accountId) {
      clientAccountIds = await getClientAccountIds(authContactId)
      if (!clientAccountIds.includes(accountId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    } else if (contactIdParam && contactIdParam !== authContactId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    } else if (contactIdParam) {
      // Fetch account IDs so we can include account-scoped admin messages below.
      clientAccountIds = await getClientAccountIds(authContactId)
    }
  }

  // Per-company client scoping (2026-06-24). scope=company selects a single
  // company's thread; scope=personal selects the contact's own untagged thread
  // (formation / personal). Admin + legacy callers omit scope and are
  // unaffected (they fall through to the contact_id / account_id branches below).
  let scopedPlan: ChatQueryPlan | null = null
  if (scope === 'company' || scope === 'personal') {
    if (scope === 'company') {
      if (!accountId) {
        return NextResponse.json({ error: 'account_id required for scope=company' }, { status: 400 })
      }
      // Access for client users (contacts in clientAccountIds, teammates to
      // their one account) was already enforced in the block above.
      // Decide personal-NULL inclusion SERVER-SIDE (never trust the client):
      // include a contact's untagged messages ONLY when this account is
      // sole-owned by them (exactly one linked contact == the viewer). This is
      // the privacy boundary — see lib/portal/chat-scope.ts. Teammates
      // (no authContactId) never get personal NULLs.
      const includePersonalNull = authContactId
        ? await resolvePersonalNullInclusion(accountId, authContactId)
        : false
      scopedPlan = buildChatQueryPlan({ scope: 'company', accountId, contactId: authContactId, includePersonalNull })
    } else {
      // personal / formation — only the viewer's own untagged messages.
      if (!authContactId) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
      scopedPlan = buildChatQueryPlan({ scope: 'personal', accountId: null, contactId: authContactId, includePersonalNull: false })
    }
  }

  let query = supabaseAdmin
    .from('portal_messages')
    .select('*, contacts:contact_id(full_name)')
    .order('created_at', { ascending: false })
    .limit(limit)

  // Client users (contacts AND teammates) never see soft-deleted messages.
  // Admins see them so they can render tombstones.
  if (isClientUser) {
    query = query.is('deleted_at', null)
    // Hide ONLY internal chat-event notes — the ones carrying the
    // `<!-- chat-event: -->` marker (e.g. "Client paid…", "fax to IRS"). These are
    // written in OUR language ABOUT the client and feed the staff "What's New"
    // view. Do NOT hide all sender_type='system' messages: the out-of-office
    // auto-reply is sender_type='system' WITHOUT a marker and IS meant for the
    // client. See sysdoc notification-center-workflow-integration-plan.
    query = query.not('message', 'ilike', '%<!-- chat-event:%')
  } else {
    // STAFF reads: hide payment_received events from the Messages thread.
    // "Client paid INV-…" is bookkeeping ABOUT the client, not conversation —
    // it already surfaces as a What's New card (payment_received event key,
    // lib/notifications/whats-new-defaults.ts), so rendering it inline in the
    // chat duplicated it in the wrong place (Antonio, 2026-07-02, Umberto
    // Moretti thread). Other event kinds keep their inline pills for now.
    query = query.not('message', 'ilike', '%<!-- chat-event: kind=payment_received%')
  }

  // Per-company scoped plan takes precedence (client switched to a company /
  // personal thread). Mirrors lib/portal/chat-scope.ts::messageVisibleInPlan.
  if (scopedPlan) {
    if (scopedPlan.mode === 'account') {
      query = query.eq('account_id', scopedPlan.accountId)
    } else if (scopedPlan.mode === 'account_plus_personal') {
      query = query.or(
        `account_id.eq.${scopedPlan.accountId},and(account_id.is.null,contact_id.eq.${scopedPlan.contactId})`
      )
    } else {
      query = query.is('account_id', null).eq('contact_id', scopedPlan.contactId)
    }
  }
  // Threading: contact_id param returns the unified per-contact thread.
  // We also include messages saved with contact_id=NULL but account_id matching
  // one of the contact's linked accounts — covers replies sent via the CRM
  // dashboard or MCP tool that historically omitted contact_id.
  else if (contactIdParam) {
    // For client users, account IDs were already resolved above.
    // For admin users, look them up now from account_contacts.
    let threadAccountIds = clientAccountIds
    if (!isClientUser && threadAccountIds.length === 0) {
      threadAccountIds = await getClientAccountIds(contactIdParam)
    }

    // Superset rule shared with the What's New feed via lib/portal/thread-scope
    // so the two thread definitions can never drift.
    query = query.or(contactThreadOrFilter(contactIdParam, threadAccountIds))
  } else if (accountId) {
    query = query.eq('account_id', accountId)
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
      // Contact name for client/owner messages; stored sender_name (the teammate's
      // display name) when there's no contact; null → UI shows its generic label.
      sender_name: pickChatSenderName(contact?.full_name, (rest as { sender_name?: string | null }).sender_name),
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
  const { account_id, contact_id: bodyContactId, sender_context: rawSenderContext, topic: rawTopic, message, attachment_url, attachment_name, attachments, reply_to_id } = body

  if (!account_id && !bodyContactId && !getClientContactId(user)) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  if (!message?.trim() && !attachment_url && (!attachments || attachments.length === 0)) {
    return NextResponse.json({ error: 'message or attachment required' }, { status: 400 })
  }

  // PR 2 Step 6 — sender_context: 'person' | 'company' | null. NULL is
  // accepted (legacy callers / admin replies that don't pass a tag).
  // 'company' requires account_id to be set.
  // 'person' implies account_id=NULL — enforced below at insert time.
  let sender_context: 'person' | 'company' | null = null
  if (rawSenderContext === 'person' || rawSenderContext === 'company') {
    sender_context = rawSenderContext
  } else if (rawSenderContext != null) {
    return NextResponse.json({ error: 'Invalid sender_context (must be person or company)' }, { status: 400 })
  }
  if (sender_context === 'company' && !account_id) {
    return NextResponse.json({ error: 'sender_context=company requires account_id' }, { status: 400 })
  }
  if (sender_context === 'person' && account_id) {
    return NextResponse.json({ error: 'sender_context=person must not include account_id' }, { status: 400 })
  }

  // Input validation: max message length
  if (message && message.length > 5000) {
    return NextResponse.json({ error: 'Message too long (max 5000 characters)' }, { status: 400 })
  }

  // Validate attachment_url is from our storage only
  // .trim() guards against trailing \n in env var (which broke uploads on 2026-04-18 when env vars were re-entered)
  const supabaseBaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  if (attachment_url && !attachment_url.startsWith(supabaseBaseUrl)) {
    return NextResponse.json({ error: 'Invalid attachment URL' }, { status: 400 })
  }

  // Validate each attachment URL in the array
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (!att.url || !att.url.startsWith(supabaseBaseUrl)) {
        return NextResponse.json({ error: 'Invalid attachment URL' }, { status: 400 })
      }
    }
  }

  // Determine sender type
  const isClientUser = user.app_metadata?.role === 'client'
  const senderType = isClientUser ? 'client' : 'admin'

  // Resolve contact_id — always set (from body, or from auth user).
  // For admin senders with only account_id, look up the primary contact so the
  // message appears in the client's contact-scoped thread (fixes invisible admin messages).
  const authContactId = getClientContactId(user)
  let resolvedContactId: string | null
  let teammateSenderName: string | null = null

  if (isClientUser && !authContactId) {
    // Teammate (Portal Team Access): may post ONLY to their own account, ONLY
    // with 'chat' granted, and NEVER under a body-supplied contact_id. Stamp the
    // teammate's display name on the row so the thread shows WHICH teammate wrote
    // (teammates have no contact, so there's otherwise no name to display).
    const access = await requirePortalCapability(user, 'chat')
    if (!access.allowed || access.kind !== 'teammate' || !account_id || account_id !== access.accountId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    resolvedContactId = null
    teammateSenderName = access.displayName || null
  } else {
    resolvedContactId = bodyContactId || authContactId
    if (!resolvedContactId && account_id && !isClientUser) {
      // Admin send with only account_id → target any linked contact so the
      // message lands in the client's contact-scoped thread.
      const { data: primary } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', account_id)
        .limit(1)
        .maybeSingle()
      resolvedContactId = primary?.contact_id || null
    }
    // Verify access for client contacts
    if (isClientUser) {
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
  }

  let topic = typeof rawTopic === 'string' && rawTopic.trim() ? rawTopic.trim().slice(0, 100) : null

  // Flow threading: a reply to a flow-scoped message inherits that message's
  // service_delivery_id (and its topic when none was supplied) so client replies
  // thread back to the flow Workspace chat (/flows/[id]). Additive — only set
  // when the parent is flow-scoped; every other send is unchanged.
  // service_delivery_id isn't in the generated DB types yet, so the parent read
  // and the insert go through an untyped surface (mirrors app/api/flows/[id]/*).
  let inheritedServiceDeliveryId: string | null = null
  if (reply_to_id) {
    const parentSurface = supabaseAdmin as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (col: string, v: string) => {
            maybeSingle: () => Promise<{
              data: { service_delivery_id: string | null; topic: string | null } | null
            }>
          }
        }
      }
    }
    const { data: parent } = await parentSurface
      .from('portal_messages')
      .select('service_delivery_id, topic')
      .eq('id', reply_to_id)
      .maybeSingle()
    if (parent?.service_delivery_id) {
      inheritedServiceDeliveryId = parent.service_delivery_id
      if (!topic && parent.topic) topic = parent.topic
    }
  }

  const insertSurface = supabaseAdmin as unknown as {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => {
        select: (c: string) => {
          single: () => Promise<{
            data: (Record<string, unknown> & { contacts: { full_name: string } | null }) | null
            error: { message: string } | null
          }>
        }
      }
    }
  }
  const { data, error } = await insertSurface
    .from('portal_messages')
    .insert({
      account_id: account_id || null,
      contact_id: resolvedContactId || null,
      sender_type: senderType,
      sender_id: user.id,
      ...(teammateSenderName ? { sender_name: teammateSenderName } : {}),
      sender_context,
      topic,
      message: (message || '').trim(),
      attachment_url: attachment_url || null,
      attachment_name: attachment_name || null,
      attachments: Array.isArray(attachments) ? attachments : [],
      reply_to_id: reply_to_id || null,
      ...(inheritedServiceDeliveryId ? { service_delivery_id: inheritedServiceDeliveryId } : {}),
    })
    .select('*, contacts:contact_id(full_name)')
    .single()

  if (error || !data) return NextResponse.json({ error: error?.message || 'Could not send message' }, { status: 500 })

  // Flatten sender_name
  const contact = data.contacts as unknown as { full_name: string } | null
  const { contacts: _contacts, ...msgData } = data
  const responseMsg = { ...msgData, sender_name: pickChatSenderName(contact?.full_name, (msgData as { sender_name?: string | null }).sender_name) }

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
    notifyClientOfAdminMessage({
      account_id: account_id || null,
      contact_id: resolvedContactId || null,
      topic,
      messagePreview: (message || '').trim(),
    }).catch(() => {})
  }

  // Notify admin when client sends a message. The email is gated by an
  // app_settings toggle (Dev Tools → Maintenance); push is always sent.
  // Also send an out-of-office auto-reply when the office is closed.
  if (senderType === 'client') {
    if (await isPortalAdminEmailEnabled()) {
      notifyAdminOfClientMessage(account_id, resolvedContactId, user.email || '', (message || '').trim()).catch(() => {})
    }
    pushNotifyAdmin(account_id, resolvedContactId, (message || '').trim()).catch(() => {})

    if (!isOfficeOpen()) {
      sendOfficeClosedAutoReply({
        account_id: account_id || null,
        contact_id: resolvedContactId,
        topic,
      }).catch(() => {})
    }
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
