import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendPushToAccount, sendPushToContact } from './web-push'
import { PORTAL_BASE_URL } from '@/lib/config'
import { escapeHtml } from '@/lib/html-escape'
import { localeFromLanguage, isItalian } from '@/lib/locale'

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
  /** When true, the row is born with email_sent_at set so the portal-digest
   * cron never emails it — for callers that send their own immediate email
   * (lib/portal/action-required.ts). Push + bell are unaffected. */
  suppressDigestEmail?: boolean
}) {
  if (!params.account_id && !params.contact_id) {
    console.error('createPortalNotification: account_id or contact_id required')
    return
  }

  const { suppressDigestEmail, ...row } = params
  const { error } = await supabaseAdmin
    .from('portal_notifications')
    .insert(suppressDigestEmail ? { ...row, email_sent_at: new Date().toISOString() } : row)

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
          <p>Dear ${escapeHtml(contact.full_name || 'Client')},</p>
          <h2 style="margin: 16px 0 8px; font-size: 16px; color: #111827;">${escapeHtml(title)}</h2>
          ${body ? `<p style="color: #4b5563;">${escapeHtml(body)}</p>` : ''}
          <div style="margin-top: 24px;">
            <a href="https://portal.tonydurante.us/portal" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Open Portal
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
            ${escapeHtml(account?.company_name || 'Your account')} — Tony Durante LLC
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
          <p>Dear ${escapeHtml(contact.full_name || 'Client')},</p>
          <h2 style="margin: 16px 0 8px; font-size: 16px; color: #111827;">${escapeHtml(title)}</h2>
          ${body ? `<p style="color: #4b5563;">${escapeHtml(body)}</p>` : ''}
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

// Throttle: 1 email per conversation per 2 hours (avoids spam when admin sends multiple messages)
const recentClientNotifications = new Map<string, number>()

/** De-duplicate notification recipients by lowercased email (first occurrence wins). */
export function dedupeRecipientsByEmail<T extends { email: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((r) => {
    const key = r.email.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Send an email to the client when an admin sends a portal chat message.
 * Throttled: max 1 email per conversation per 2 hours.
 * Called by the API route and the portal_chat_send MCP tool.
 *
 * Recipients (account_id path): ALL account contacts PLUS active Portal Team
 * Access teammates who have the 'chat' capability and a real email on file
 * (teammates aren't in account_contacts, so they'd otherwise be missed).
 */
export async function notifyClientOfAdminMessage({
  account_id,
  contact_id,
  topic,
  messagePreview,
}: {
  account_id?: string | null
  contact_id?: string | null
  topic?: string | null
  messagePreview: string
}): Promise<void> {
  const baseKey = account_id || contact_id
  if (!baseKey) return

  // Per-topic throttle: each topic gets its own 2-hour notification window.
  // Messages with no topic share a single window (backward-compatible).
  const throttleKey = topic ? `${topic}::${baseKey}` : baseKey

  const lastSent = recentClientNotifications.get(throttleKey) ?? 0
  if (Date.now() - lastSent < 2 * 60 * 60 * 1000) return
  recentClientNotifications.set(throttleKey, Date.now())

  // Resolve all recipients. For contact_id: one recipient. For account_id: ALL
  // contacts on the account so every member of a Multi-Member LLC is notified.
  type Recipient = { email: string; firstName: string | null; language: string; contactId: string | null }
  let recipients: Recipient[] = []

  if (contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('email, full_name, language')
      .eq('id', contact_id)
      .single()
    if (contact?.email) {
      recipients = [{ email: contact.email, firstName: contact.full_name?.split(' ')[0] ?? null, language: contact.language ?? 'en', contactId: contact_id }]
    }
  } else if (account_id) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('role, contacts(id, email, full_name, language)')
      .eq('account_id', account_id)
    const linkRows = links ?? []
    const contactRecipients = linkRows
      .map(l => {
        const c = l.contacts as { id: string; email: string; full_name: string; language: string } | null
        if (!c?.email) return null
        return { email: c.email, firstName: c.full_name?.split(' ')[0] ?? null, language: c.language ?? 'en', contactId: c.id ?? null }
      })
      .filter((r): r is Recipient => r !== null)

    // Teammates have no language column — they follow the OWNER's language.
    // Prefer the owner-role contact's language; fall back to any contact with a
    // language set, then English (e.g. teammate-only account with no contacts).
    const ownerLink =
      linkRows.find(l => (l as { role?: string | null }).role === 'owner' && (l.contacts as { language?: string } | null)?.language)
      ?? linkRows.find(l => (l.contacts as { language?: string } | null)?.language)
    const ownerLanguage = (ownerLink?.contacts as { language?: string } | null)?.language ?? 'en'

    // Portal Team Access: also notify active teammates of this account who can
    // see chat (the email CTA links to /portal/chat, so only chat-capable
    // teammates are relevant) and have a real email on file. Teammates are NOT
    // in account_contacts, so they'd otherwise be missed. The placeholder email
    // generated when an owner omits one lives only on auth.users — never on
    // portal_team_members.email — so a non-null filter stays deliverable-safe.
    const { data: teammates } = await supabaseAdmin
      .from('portal_team_members')
      .select('email, display_name, capabilities, status')
      .eq('account_id', account_id)
      .eq('status', 'active')
    const teammateRecipients: Recipient[] = (teammates ?? [])
      .filter((t) => t.status === 'active' && !!t.email && (t.capabilities as Record<string, unknown> | null)?.chat === true)
      .map((t) => ({
        email: t.email as string,
        firstName: ((t.display_name as string | null) ?? '').split(' ')[0] || null,
        language: ownerLanguage, // teammates follow the account owner's language
        contactId: null, // teammates aren't contacts; covered by the account-level push check
      }))

    // Dedupe so a teammate sharing a contact's email isn't emailed twice.
    recipients = dedupeRecipientsByEmail([...contactRecipients, ...teammateRecipients])
  }

  if (recipients.length === 0) return

  const { gmailPost } = await import('@/lib/gmail')
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const preview = escHtml(messagePreview.slice(0, 200) || '…')
  const portalChatUrl = `${PORTAL_BASE_URL}/portal/chat`

  for (const recipient of recipients) {
    // Skip email if this client already has active push subscriptions (PWA with
    // notifications) — they'll get the push instead. Check contact-level first,
    // then account-level (some subscriptions are keyed by account, not contact).
    let hasPush = false
    if (recipient.contactId) {
      const { count } = await supabaseAdmin
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', recipient.contactId)
      if (count && count > 0) hasPush = true
    }
    if (!hasPush && account_id) {
      const { count } = await supabaseAdmin
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', account_id)
      if (count && count > 0) hasPush = true
    }
    if (hasPush) continue // has push — skip the redundant email

    // contacts.language is messy free text ("Italian", "Italiano", "it", …) —
    // the canonical normalizer decides. A strict === 'it' check here used to
    // send English chat emails to every Italian client (2026-07-02 fix).
    const isIt = isItalian(recipient.language)
    const greeting = recipient.firstName ? (isIt ? `Ciao ${recipient.firstName},` : `Hi ${recipient.firstName},`) : (isIt ? 'Ciao,' : 'Hi,')
    const subject = isIt ? 'Nuovo messaggio dal team Tony Durante' : 'New message from the Tony Durante team'
    const bodyText = isIt
      ? 'Hai ricevuto un nuovo messaggio dal nostro team. Accedi al portale per leggerlo e rispondere.'
      : 'You have a new message from our team. Log in to your portal to read and reply.'
    const ctaLabel = isIt ? 'Vai al Portale' : 'Go to Portal'
    const footerText = isIt ? 'Tony Durante LLC — Portale Clienti' : 'Tony Durante LLC — Client Portal'

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
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
      const boundary = `boundary_${Date.now()}`
      const raw = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: ${recipient.email}`,
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
      console.error(`[notifyClientOfAdminMessage] Email failed for ${recipient.email}:`, err)
    }
  }
}

/**
 * Bilingual stage-change email for service delivery advances.
 * Phase 4 (2026-05-11): called by advanceServiceDelivery when the target
 * stage has pipeline_stages.notify_client_email = true. Resolves recipients
 * via contact_id (preferred) or all account_contacts links (so every member
 * of a Multi-Member LLC is notified).
 */
/**
 * Pure email-copy builder for the stage-advance notification. Returns RAW
 * (unescaped) strings — the caller escapes before injecting into HTML. When
 * `customMessage` is set (from pipeline_stages.client_notification_message), it
 * becomes the email headline and the generic secondary line is dropped;
 * otherwise the standard bilingual "service moved to stage" copy is used.
 */
export function buildStageAdvanceCopy(opts: {
  locale: 'en' | 'it'
  serviceName: string
  stageName: string
  firstName?: string | null
  customMessage?: string | null
}): { subject: string; greeting: string; headline: string; bodyText: string; ctaLabel: string; footerText: string } {
  const { locale, serviceName, stageName, firstName, customMessage } = opts
  const isIt = locale === 'it'
  const greeting = firstName
    ? (isIt ? `Ciao ${firstName},` : `Hi ${firstName},`)
    : (isIt ? 'Ciao,' : 'Hi,')
  const subject = isIt
    ? `Aggiornamento servizio: ${serviceName} — ${stageName}`
    : `Service update: ${serviceName} — ${stageName}`
  const custom = customMessage?.trim()
  const headline = custom
    ? custom
    : (isIt
        ? `Il tuo servizio "${serviceName}" è passato alla fase "${stageName}".`
        : `Your service "${serviceName}" has moved to the "${stageName}" stage.`)
  // Custom message is self-contained — no generic secondary line under it.
  const bodyText = custom
    ? ''
    : (isIt
        ? 'Accedi al portale clienti per vedere i dettagli aggiornati.'
        : 'Log in to the client portal to see the latest details.')
  const ctaLabel = isIt ? 'Apri il Portale' : 'Open the Portal'
  const footerText = isIt ? 'Tony Durante LLC — Portale Clienti' : 'Tony Durante LLC — Client Portal'
  return { subject, greeting, headline, bodyText, ctaLabel, footerText }
}

export async function notifyClientOfStageAdvance(params: {
  account_id?: string | null
  contact_id?: string | null
  service_name: string
  stage_name: string
  /** Optional per-stage custom body (pipeline_stages.client_notification_message). */
  custom_message?: string | null
}): Promise<{ sent: number; failed: number }> {
  const { account_id, contact_id, service_name, stage_name, custom_message } = params

  type Recipient = { email: string; firstName: string | null; language: string }
  let recipients: Recipient[] = []

  if (contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('email, full_name, language')
      .eq('id', contact_id)
      .single()
    if (contact?.email) {
      recipients = [{
        email: contact.email,
        firstName: contact.full_name?.split(' ')[0] ?? null,
        language: contact.language ?? 'en',
      }]
    }
  } else if (account_id) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('contacts(email, full_name, language)')
      .eq('account_id', account_id)
    recipients = (links ?? [])
      .map(l => {
        const c = l.contacts as { email: string; full_name: string; language: string } | null
        if (!c?.email) return null
        return {
          email: c.email,
          firstName: c.full_name?.split(' ')[0] ?? null,
          language: c.language ?? 'en',
        }
      })
      .filter((r): r is Recipient => r !== null)
  }

  if (recipients.length === 0) return { sent: 0, failed: 0 }

  const { gmailPost } = await import('@/lib/gmail')
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const portalServicesUrl = `${PORTAL_BASE_URL}/portal/services`

  let sent = 0
  let failed = 0

  for (const recipient of recipients) {
    const copy = buildStageAdvanceCopy({
      locale: localeFromLanguage(recipient.language),
      serviceName: service_name,
      stageName: stage_name,
      firstName: recipient.firstName,
      customMessage: custom_message,
    })
    const subject = copy.subject
    const greeting = escHtml(copy.greeting)
    const headline = escHtml(copy.headline)
    const bodyText = escHtml(copy.bodyText)
    const ctaLabel = copy.ctaLabel
    const footerText = copy.footerText

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#0A3161;padding:20px;border-radius:12px 12px 0 0;">
          <img src="https://app.tonydurante.us/images/logo.jpg" alt="Tony Durante LLC" style="height:40px;" />
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;">${greeting}</p>
          <p style="margin:0 0 16px;color:#27272a;">${headline}</p>
          ${bodyText ? `<p style="margin:0 0 24px;color:#4b5563;">${bodyText}</p>` : ''}
          <a href="${portalServicesUrl}" style="display:inline-block;padding:12px 28px;background:#0A3161;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-family:Georgia,serif;">
            ${ctaLabel}
          </a>
          <p style="color:#9ca3af;font-size:12px;margin-top:24px;">${footerText}</p>
        </div>
      </div>
    `

    try {
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
      const boundary = `boundary_${Date.now()}`
      const raw = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: ${recipient.email}`,
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
      sent++
    } catch (err) {
      console.error(`[notifyClientOfStageAdvance] Email failed for ${recipient.email}:`, err)
      failed++
    }
  }

  return { sent, failed }
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
