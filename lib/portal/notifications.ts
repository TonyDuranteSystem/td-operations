import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendPushToAccount, sendPushToContact } from './web-push'
import { PORTAL_BASE_URL } from '@/lib/config'

// Email digest is handled by /api/cron/portal-digest (every 5 min)
// All notification types are eligible for digest emails.

/**
 * Create a portal notification for a client.
 * Called by MCP tools, API routes, and cron jobs when something happens
 * that the client should know about.
 *
 * CONTACT-CENTRIC: Requires at least one of account_id or contact_id.
 * - account_id: for LLC-specific notifications (services, deadlines)
 * - contact_id: for person-level notifications (chat, ITIN, general)
 * - both: for LLC notifications where we also know the person
 */
export async function createPortalNotification(params: {
  account_id?: string
  contact_id?: string
  type: string
  title: string
  body?: string
  link?: string
}) {
  if (!params.account_id && !params.contact_id) {
    console.error('createPortalNotification: account_id or contact_id required')
    return
  }

  const { error } = await supabaseAdmin
    .from('portal_notifications')
    .insert(params)

  if (error) {
    console.error('Failed to create portal notification:', error.message)
    return
  }

  // Send Web Push (fire-and-forget) — prefer contact, fallback to account
  if (params.contact_id) {
    sendPushToContact(params.contact_id, {
      title: params.title,
      body: params.body || '',
      url: params.link || '/portal',
      tag: params.type,
    }).catch(() => {})
  } else if (params.account_id) {
    sendPushToAccount(params.account_id, {
      title: params.title,
      body: params.body || '',
      url: params.link || '/portal',
      tag: params.type,
    }).catch(() => {})
  }

  // Email is now handled by the digest cron (/api/cron/portal-digest)
  // which batches all pending notifications into one email per client every 5 minutes.
  // No immediate email — only push notifications are instant.
}

/**
 * Send email notification to the primary contact of an account.
 * NOTE: No longer called from createPortalNotification (digest handles email).
 * Kept as utility for direct email needs.
 */
async function _sendNotificationEmail(accountId: string, title: string, body: string) {
  // Get primary contact email
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)
    .limit(1)

  if (!links?.length) return

  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('email, full_name')
    .eq('id', links[0].contact_id)
    .single()

  if (!contact?.email) return

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', accountId)
    .single()

  try {
    const { gmailPost } = await import('@/lib/gmail')

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #2563eb; padding: 20px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 18px;">TD Portal</h1>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <p>Dear ${contact.full_name || 'Client'},</p>
          <h2 style="margin: 16px 0 8px; font-size: 16px; color: #111827;">${title}</h2>
          ${body ? `<p style="color: #4b5563;">${body}</p>` : ''}
          <div style="margin-top: 24px;">
            <a href="https://portal.tonydurante.us/portal" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Open Portal
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
            ${account?.company_name || 'Your account'} — Tony Durante LLC
          </p>
        </div>
      </div>
    `

    const encodedSubject = `=?utf-8?B?${Buffer.from(title).toString("base64")}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: TD Portal <support@tonydurante.us>`,
      `To: ${contact.email}`,
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
    console.error('Notification email failed:', err)
  }
}

/**
 * Send email notification directly to a contact (no account lookup needed).
 * NOTE: No longer called from createPortalNotification (digest handles email).
 * Kept as utility for direct email needs.
 */
async function _sendNotificationEmailToContact(contactId: string, title: string, body: string) {
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('email, full_name')
    .eq('id', contactId)
    .single()

  if (!contact?.email) return

  try {
    const { gmailPost } = await import('@/lib/gmail')

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #2563eb; padding: 20px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 18px;">TD Portal</h1>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <p>Dear ${contact.full_name || 'Client'},</p>
          <h2 style="margin: 16px 0 8px; font-size: 16px; color: #111827;">${title}</h2>
          ${body ? `<p style="color: #4b5563;">${body}</p>` : ''}
          <div style="margin-top: 24px;">
            <a href="https://portal.tonydurante.us/portal" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Open Portal
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
            Tony Durante LLC
          </p>
        </div>
      </div>
    `

    const encodedSubject = `=?utf-8?B?${Buffer.from(title).toString("base64")}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: TD Portal <support@tonydurante.us>`,
      `To: ${contact.email}`,
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
    console.error('Notification email to contact failed:', err)
  }
}

// Throttle: 1 email per conversation per 5 minutes (avoids spam when admin sends multiple messages)
const recentClientNotifications = new Map<string, number>()

/**
 * Send an email to the client when an admin sends a portal chat message.
 * Throttled: max 1 email per conversation per 5 minutes.
 * Called by the API route and the portal_chat_send MCP tool.
 */
export async function notifyClientOfAdminMessage({
  account_id,
  contact_id,
  messagePreview,
}: {
  account_id?: string | null
  contact_id?: string | null
  messagePreview: string
}): Promise<void> {
  const throttleKey = account_id || contact_id
  if (!throttleKey) return

  const lastSent = recentClientNotifications.get(throttleKey) ?? 0
  if (Date.now() - lastSent < 5 * 60 * 1000) return
  recentClientNotifications.set(throttleKey, Date.now())

  // Resolve contact: email, name, language
  let email: string | null = null
  let firstName: string | null = null
  let language = 'en'

  if (contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('email, full_name, language')
      .eq('id', contact_id)
      .single()
    email = contact?.email ?? null
    firstName = contact?.full_name?.split(' ')[0] ?? null
    language = contact?.language ?? 'en'
  } else if (account_id) {
    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contacts(email, full_name, language)')
      .eq('account_id', account_id)
      .limit(1)
      .maybeSingle()
    const contact = (link?.contacts as { email: string; full_name: string; language: string } | null)
    email = contact?.email ?? null
    firstName = contact?.full_name?.split(' ')[0] ?? null
    language = contact?.language ?? 'en'
  }

  if (!email) return

  const isIt = language === 'it'
  const greeting = firstName ? (isIt ? `Ciao ${firstName},` : `Hi ${firstName},`) : (isIt ? 'Ciao,' : 'Hi,')
  const subject = isIt ? 'Nuovo messaggio dal team Tony Durante' : 'New message from the Tony Durante team'
  const bodyText = isIt
    ? 'Hai ricevuto un nuovo messaggio dal nostro team. Accedi al portale per leggerlo e rispondere.'
    : 'You have a new message from our team. Log in to your portal to read and reply.'
  const ctaLabel = isIt ? 'Vai al Portale' : 'Go to Portal'
  const footerText = isIt ? 'Tony Durante LLC — Portale Clienti' : 'Tony Durante LLC — Client Portal'

  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const preview = escHtml(messagePreview.slice(0, 200) || '…')
  const portalChatUrl = `${PORTAL_BASE_URL}/portal/chat`

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0A3161;padding:20px;border-radius:12px 12px 0 0;">
        <img src="https://app.tonydurante.us/images/logo.jpg" alt="Tony Durante LLC" style="height:40px;" />
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">${bodyText}</p>
        <div style="background:#f4f4f5;padding:16px;border-radius:8px;margin-bottom:24px;border-left:3px solid #0A3161;">
          <p style="margin:0;color:#27272a;font-size:14px;white-space:pre-wrap;">${preview}</p>
        </div>
        <a href="${portalChatUrl}" style="display:inline-block;padding:12px 28px;background:#0A3161;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-family:Georgia,serif;">
          ${ctaLabel}
        </a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">${footerText}</p>
      </div>
    </div>
  `

  try {
    const { gmailPost } = await import('@/lib/gmail')
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
    const boundary = `boundary_${Date.now()}`
    const raw = [
      `From: Tony Durante LLC <support@tonydurante.us>`,
      `To: ${email}`,
      `Subject: ${encodedSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(html).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n')
    await gmailPost('/messages/send', { raw: Buffer.from(raw).toString('base64url') })
  } catch (err) {
    console.error('[notifyClientOfAdminMessage] Email failed:', err)
  }
}

/**
 * Get unread notification count.
 * Supports both account-based and contact-based queries.
 */
export async function getUnreadNotificationCount(
  accountId?: string,
  contactId?: string
): Promise<number> {
  let query = supabaseAdmin
    .from('portal_notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  if (accountId) {
    query = query.eq('account_id', accountId)
  } else if (contactId) {
    query = query.eq('contact_id', contactId)
  } else {
    return 0
  }

  const { count } = await query
  return count ?? 0
}
