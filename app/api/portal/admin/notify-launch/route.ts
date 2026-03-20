import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { PORTAL_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/admin/notify-launch
 * Returns list of portal accounts with their notification status.
 *
 * POST /api/portal/admin/notify-launch
 * Sends launch notification email to selected accounts.
 * Body: { account_ids: string[] } or { send_all: true }
 */

// Email HTML template
function buildLaunchEmail(name: string, email: string, loginUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#18181b 0%,#27272a 100%);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:white;margin:0;font-size:22px;font-weight:700;">Tony Durante</h1>
    <p style="color:#a1a1aa;margin:6px 0 0;font-size:13px;">Business Services</p>
  </div>

  <!-- Body -->
  <div style="background:white;padding:32px 24px;border:1px solid #e5e7eb;border-top:none;">
    <p style="font-size:16px;color:#18181b;margin:0 0 16px;">Hi ${name},</p>

    <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0 0 16px;">
      We're excited to announce that your <strong>Client Portal</strong> is now live!
      You can now manage your business with us more easily than ever.
    </p>

    <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0 0 8px;">
      <strong>What you can do in the portal:</strong>
    </p>

    <table style="width:100%;margin:0 0 20px;" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📊</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Dashboard</strong> — Overview of all your services, deadlines, and recent activity</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📄</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Documents</strong> — Access and download all your business documents</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">💰</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Invoices</strong> — Create, send, and track invoices for your business</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">💬</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Chat</strong> — Message us directly with AI-powered suggestions</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📋</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Services</strong> — Track the status of all your active services</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📅</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Deadlines</strong> — Never miss a filing deadline or renewal date</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;">
          <span style="font-size:16px;margin-right:8px;">🔔</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Notifications</strong> — Real-time updates on your account activity</span>
        </td>
      </tr>
    </table>

    <!-- CTA Button -->
    <div style="text-align:center;margin:24px 0;">
      <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">
        Access Your Portal →
      </a>
    </div>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:20px 0;">
      <p style="font-size:13px;color:#1e40af;margin:0 0 8px;font-weight:600;">🔐 Your Login Credentials</p>
      <p style="font-size:13px;color:#1e40af;margin:0 0 4px;"><strong>Email:</strong> ${email}</p>
      <p style="font-size:13px;color:#1e40af;margin:0;">
        <strong>Password:</strong> Use the password from your welcome email.
        If you need a new one, click "Forgot Password" on the login page.
      </p>
    </div>

    <p style="font-size:13px;color:#71717a;line-height:1.6;margin:20px 0 0;">
      If you have any questions, just reply to this email or use the chat feature in the portal.
    </p>
  </div>

  <!-- Footer -->
  <div style="padding:16px 24px;text-align:center;">
    <p style="font-size:11px;color:#a1a1aa;margin:0;">
      Tony Durante LLC · Business Services<br>
      This is an automated notification from your client portal.
    </p>
  </div>

</div>
</body>
</html>`
}

// Italian version
function buildLaunchEmailIT(name: string, email: string, loginUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#18181b 0%,#27272a 100%);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:white;margin:0;font-size:22px;font-weight:700;">Tony Durante</h1>
    <p style="color:#a1a1aa;margin:6px 0 0;font-size:13px;">Business Services</p>
  </div>

  <!-- Body -->
  <div style="background:white;padding:32px 24px;border:1px solid #e5e7eb;border-top:none;">
    <p style="font-size:16px;color:#18181b;margin:0 0 16px;">Ciao ${name},</p>

    <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0 0 16px;">
      Siamo felici di annunciarti che il tuo <strong>Portale Clienti</strong> è ora attivo!
      Potrai gestire i tuoi servizi con noi in modo più semplice e veloce.
    </p>

    <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0 0 8px;">
      <strong>Cosa puoi fare nel portale:</strong>
    </p>

    <table style="width:100%;margin:0 0 20px;" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📊</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Dashboard</strong> — Panoramica di tutti i tuoi servizi, scadenze e attività recenti</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📄</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Documenti</strong> — Accedi e scarica tutti i tuoi documenti aziendali</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">💰</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Fatture</strong> — Crea, invia e monitora le fatture della tua azienda</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">💬</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Chat</strong> — Scrivici direttamente con suggerimenti AI integrati</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📋</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Servizi</strong> — Monitora lo stato di tutti i tuoi servizi attivi</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f4f4f5;">
          <span style="font-size:16px;margin-right:8px;">📅</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Scadenze</strong> — Non perdere mai una scadenza fiscale o un rinnovo</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 12px;">
          <span style="font-size:16px;margin-right:8px;">🔔</span>
          <span style="font-size:13px;color:#3f3f46;"><strong>Notifiche</strong> — Aggiornamenti in tempo reale sulla tua attività</span>
        </td>
      </tr>
    </table>

    <!-- CTA Button -->
    <div style="text-align:center;margin:24px 0;">
      <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">
        Accedi al Portale →
      </a>
    </div>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:20px 0;">
      <p style="font-size:13px;color:#1e40af;margin:0 0 8px;font-weight:600;">🔐 Le tue credenziali</p>
      <p style="font-size:13px;color:#1e40af;margin:0 0 4px;"><strong>Email:</strong> ${email}</p>
      <p style="font-size:13px;color:#1e40af;margin:0;">
        <strong>Password:</strong> Usa la password dall'email di benvenuto.
        Se ne hai bisogno di una nuova, clicca "Password Dimenticata" nella pagina di login.
      </p>
    </div>

    <p style="font-size:13px;color:#71717a;line-height:1.6;margin:20px 0 0;">
      Per qualsiasi domanda, rispondi a questa email o usa la chat nel portale.
    </p>
  </div>

  <!-- Footer -->
  <div style="padding:16px 24px;text-align:center;">
    <p style="font-size:11px;color:#a1a1aa;margin:0;">
      Tony Durante LLC · Business Services<br>
      Questa è una notifica automatica dal tuo portale clienti.
    </p>
  </div>

</div>
</body>
</html>`
}

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Get all portal accounts with their contact info
  const { data: accounts, error } = await supabaseAdmin
    .from('accounts')
    .select(`
      id, company_name, portal_account, portal_created_date, notes,
      account_contacts (
        contact_id,
        contacts ( id, full_name, email )
      )
    `)
    .eq('portal_account', true)
    .order('company_name')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Check which accounts have already been notified (stored in account notes)
  const result = (accounts || []).map((acc) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contacts = (acc.account_contacts as any[])?.map(ac => ac.contacts).filter(Boolean) || []
    const primaryContact = contacts[0]
    const notified = acc.notes?.includes('[PORTAL_LAUNCH_NOTIFIED]') || false

    return {
      id: acc.id,
      company_name: acc.company_name,
      contact_name: primaryContact?.full_name || 'N/A',
      contact_email: primaryContact?.email || null,
      portal_created_date: acc.portal_created_date,
      notified,
    }
  })

  return NextResponse.json({ accounts: result })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { account_ids, send_all, language = 'en', preview } = body

  // Preview mode — return the email HTML without sending
  if (preview) {
    const html = language === 'it'
      ? buildLaunchEmailIT('Marco', 'marco@example.com', `${PORTAL_BASE_URL}/portal/login`)
      : buildLaunchEmail('Marco', 'marco@example.com', `${PORTAL_BASE_URL}/portal/login`)
    return NextResponse.json({ preview_html: html })
  }

  if (!account_ids?.length && !send_all) {
    return NextResponse.json({ error: 'account_ids array or send_all required' }, { status: 400 })
  }

  // Get target accounts
  let query = supabaseAdmin
    .from('accounts')
    .select(`
      id, company_name, notes,
      account_contacts (
        contact_id,
        contacts ( id, full_name, email )
      )
    `)
    .eq('portal_account', true)

  if (!send_all && account_ids?.length) {
    query = query.in('id', account_ids)
  }

  const { data: accounts, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { gmailPost } = await import('@/lib/gmail')
  const loginUrl = `${PORTAL_BASE_URL}/portal/login`
  const results: { account_id: string; company: string; email: string; status: string; error?: string }[] = []

  for (const acc of accounts || []) {
    // Skip already notified unless explicitly re-sending
    if (acc.notes?.includes('[PORTAL_LAUNCH_NOTIFIED]') && !body.force) {
      results.push({ account_id: acc.id, company: acc.company_name, email: '', status: 'skipped_already_notified' })
      continue
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contacts = (acc.account_contacts as any[])?.map(ac => ac.contacts).filter(Boolean) || []
    const primaryContact = contacts[0]

    if (!primaryContact?.email) {
      results.push({ account_id: acc.id, company: acc.company_name, email: '', status: 'skipped_no_email' })
      continue
    }

    try {
      const name = primaryContact.full_name?.split(' ')[0] || primaryContact.full_name || 'there'
      const html = language === 'it'
        ? buildLaunchEmailIT(name, primaryContact.email, loginUrl)
        : buildLaunchEmail(name, primaryContact.email, loginUrl)

      const subject = language === 'it'
        ? 'Il tuo Portale Clienti è attivo!'
        : 'Your Client Portal is Live!'

      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const rawEmail = [
        `From: Tony Durante <support@tonydurante.us>`,
        `To: ${primaryContact.email}`,
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

      // Mark as notified in account notes
      const existingNotes = acc.notes || ''
      const timestamp = new Date().toISOString().split('T')[0]
      const newNote = `${timestamp}: Portal launch notification sent [PORTAL_LAUNCH_NOTIFIED]`
      await supabaseAdmin
        .from('accounts')
        .update({ notes: existingNotes ? `${existingNotes}\n${newNote}` : newNote })
        .eq('id', acc.id)

      results.push({ account_id: acc.id, company: acc.company_name, email: primaryContact.email, status: 'sent' })

      // Small delay between emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      results.push({ account_id: acc.id, company: acc.company_name, email: primaryContact.email, status: 'failed', error: errMsg })
    }
  }

  const sent = results.filter(r => r.status === 'sent').length
  const skipped = results.filter(r => r.status.startsWith('skipped')).length
  const failed = results.filter(r => r.status === 'failed').length

  return NextResponse.json({
    summary: { sent, skipped, failed, total: results.length },
    results,
  })
}

export const maxDuration = 60
