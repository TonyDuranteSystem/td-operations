import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'
import { getGreeting } from '@/lib/greeting'
import { PORTAL_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/cron/portal-digest
 * Runs every 5 minutes. Batches all unsent portal notifications into
 * one digest email per client. Prevents email spam when multiple events
 * happen in quick succession (messages, documents, invoices).
 *
 * Only processes notifications older than 2 minutes (batching window).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Find all notifications that haven't been emailed yet
    // Only those older than 2 minutes (to allow batching window)
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()

    const { data: pending, error } = await supabaseAdmin
      .from('portal_notifications')
      .select('id, account_id, contact_id, type, title, body, created_at')
      .is('email_sent_at', null)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(500)

    if (error) {
      console.error('[portal-digest] Query error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!pending?.length) {
      return NextResponse.json({ message: 'No pending notifications', sent: 0 })
    }

    // Group by contact_id (preferred) or account_id
    const groups = new Map<string, typeof pending>()

    for (const n of pending) {
      // Use contact_id as primary key, fall back to account_id
      const key = n.contact_id
        ? `contact:${n.contact_id}`
        : n.account_id
          ? `account:${n.account_id}`
          : null

      if (!key) continue

      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(n)
    }

    let emailsSent = 0
    let notificationsProcessed = 0

    for (const [key, notifications] of Array.from(groups.entries())) {
      const [type, id] = key.split(':')

      // Resolve contact email + info
      let contactEmail: string | null = null
      let _contactName: string | null = null
      let firstName: string | null = null
      let gender: string | null = null
      let language: string | null = null
      let companyName: string | null = null

      if (type === 'contact') {
        const { data: contact } = await supabaseAdmin
          .from('contacts')
          .select('email, full_name, gender, language')
          .eq('id', id)
          .single()

        if (!contact?.email) continue
        contactEmail = contact.email
        _contactName = contact.full_name
        firstName = contact.full_name?.split(' ')[0] || null
        gender = contact.gender
        language = contact.language

        // Try to get company name from first notification's account_id
        const acctId = notifications.find(n => n.account_id)?.account_id
        if (acctId) {
          const { data: acct } = await supabaseAdmin
            .from('accounts')
            .select('company_name')
            .eq('id', acctId)
            .single()
          companyName = acct?.company_name || null
        }
      } else {
        // account-based: get primary contact
        const { data: links } = await supabaseAdmin
          .from('account_contacts')
          .select('contact_id')
          .eq('account_id', id)
          .limit(1)

        if (!links?.length) continue

        const { data: contact } = await supabaseAdmin
          .from('contacts')
          .select('email, full_name, gender, language')
          .eq('id', links[0].contact_id)
          .single()

        if (!contact?.email) continue
        contactEmail = contact.email
        _contactName = contact.full_name
        firstName = contact.full_name?.split(' ')[0] || null
        gender = contact.gender
        language = contact.language

        const { data: acct } = await supabaseAdmin
          .from('accounts')
          .select('company_name')
          .eq('id', id)
          .single()
        companyName = acct?.company_name || null
      }

      // Build greeting
      const greeting = getGreeting({
        firstName: firstName || 'Client',
        gender,
        language,
      })

      // Group notifications by type
      const byType = new Map<string, typeof notifications>()
      for (const n of notifications) {
        if (!byType.has(n.type)) byType.set(n.type, [])
        byType.get(n.type)!.push(n)
      }

      // Build sections
      const isItalian = language === 'Italian' || language === 'it'
      const sections: string[] = []

      const typeLabels: Record<string, { icon: string; label_en: string; label_it: string }> = {
        chat: { icon: '&#128172;', label_en: 'Messages', label_it: 'Messaggi' },
        service: { icon: '&#9889;', label_en: 'Service Updates', label_it: 'Aggiornamenti Servizi' },
        deadline: { icon: '&#128197;', label_en: 'Deadlines', label_it: 'Scadenze' },
        invoice: { icon: '&#128196;', label_en: 'Invoices', label_it: 'Fatture' },
        document: { icon: '&#128196;', label_en: 'Documents', label_it: 'Documenti' },
        sign_document: { icon: '&#9999;', label_en: 'Documents to Sign', label_it: 'Documenti da Firmare' },
        tax_document_uploaded: { icon: '&#128196;', label_en: 'Tax Documents', label_it: 'Documenti Fiscali' },
      }

      for (const [nType, items] of Array.from(byType.entries())) {
        const meta = typeLabels[nType] || { icon: '&#128276;', label_en: nType, label_it: nType }
        const label = isItalian ? meta.label_it : meta.label_en

        const itemsHtml = items
          .map(item => `<li style="color: #4b5563; margin: 4px 0;">${item.title}</li>`)
          .join('')

        sections.push(`
          <div style="margin-bottom: 16px;">
            <p style="font-weight: 600; font-size: 14px; color: #111827; margin: 0 0 6px;">
              ${meta.icon} ${label} (${items.length})
            </p>
            <ul style="margin: 0; padding-left: 20px; font-size: 14px;">
              ${itemsHtml}
            </ul>
          </div>
        `)
      }

      const introText = isItalian
        ? 'Hai nuovi aggiornamenti nel tuo portale:'
        : 'You have new updates in your portal:'

      const buttonText = isItalian ? 'Apri Portale' : 'Open Portal'

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #2563eb; padding: 20px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 18px;">TD Portal</h1>
          </div>
          <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
            <p style="font-size: 15px; color: #111827;">${greeting},</p>
            <p style="font-size: 14px; color: #4b5563; margin-bottom: 20px;">${introText}</p>
            ${sections.join('')}
            <div style="margin-top: 24px; text-align: center;">
              <a href="${PORTAL_BASE_URL}/portal" style="display: inline-block; padding: 12px 32px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px;">
                ${buttonText}
              </a>
            </div>
            <p style="color: #9ca3af; font-size: 12px; margin-top: 24px; text-align: center;">
              ${companyName ? `${companyName} -- ` : ''}Tony Durante LLC
            </p>
          </div>
        </div>
      `

      // Build email subject
      const totalCount = notifications.length
      const subject = isItalian
        ? `${totalCount} nuov${totalCount === 1 ? 'o aggiornamento' : 'i aggiornamenti'} nel tuo portale`
        : `${totalCount} new update${totalCount === 1 ? '' : 's'} in your portal`

      // Send email
      try {
        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
        const rawEmail = [
          `From: TD Portal <support@tonydurante.us>`,
          `To: ${contactEmail}`,
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
        emailsSent++
      } catch (err) {
        console.error(`[portal-digest] Failed to send to ${contactEmail}:`, err)
        continue // Don't mark as sent if email failed
      }

      // Mark all notifications as email-sent
      const notifIds = notifications.map(n => n.id)
      await supabaseAdmin
        .from('portal_notifications')
        .update({ email_sent_at: new Date().toISOString() })
        .in('id', notifIds)

      notificationsProcessed += notifIds.length
    }

    return NextResponse.json({
      message: `Digest sent`,
      emails_sent: emailsSent,
      notifications_processed: notificationsProcessed,
    })
  } catch (err) {
    console.error('[portal-digest] Error:', err)
    return NextResponse.json({ error: 'Digest failed' }, { status: 500 })
  }
}
