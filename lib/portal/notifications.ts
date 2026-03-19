import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendPushToAccount } from './web-push'

// Notification types that also trigger an email
const EMAIL_TYPES = ['service', 'deadline', 'tax_document_uploaded']

/**
 * Create a portal notification for a client.
 * Called by MCP tools, API routes, and cron jobs when something happens
 * that the client should know about.
 * Also sends Web Push + email for important notification types.
 */
export async function createPortalNotification(params: {
  account_id: string
  contact_id?: string
  type: string
  title: string
  body?: string
  link?: string
}) {
  const { error } = await supabaseAdmin
    .from('portal_notifications')
    .insert(params)

  if (error) {
    console.error('Failed to create portal notification:', error.message)
    return
  }

  // Send Web Push (fire-and-forget)
  sendPushToAccount(params.account_id, {
    title: params.title,
    body: params.body || '',
    url: params.link || '/portal',
    tag: params.type,
  }).catch(() => {})

  // Send email for important notification types (fire-and-forget)
  if (EMAIL_TYPES.includes(params.type)) {
    sendNotificationEmail(params.account_id, params.title, params.body || '').catch(() => {})
  }
}

/**
 * Send email notification to the primary contact of an account.
 */
async function sendNotificationEmail(accountId: string, title: string, body: string) {
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

    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: TD Portal <support@tonydurante.us>`,
      `To: ${contact.email}`,
      `Subject: ${title}`,
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
 * Get unread notification count for an account.
 */
export async function getUnreadNotificationCount(accountId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('portal_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('read_at', null)

  return count ?? 0
}
