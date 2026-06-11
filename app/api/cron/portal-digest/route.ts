import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'
import { getGreeting } from '@/lib/greeting'
import { PORTAL_BASE_URL } from '@/lib/config'
import { getCompanyEmail } from '@/lib/portal/queries'
import { getAppSetting } from '@/lib/settings'
import { buildDigestSections, mergeTypeLabels } from '@/lib/portal/digest-render'
import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'

/**
 * GET /api/cron/portal-digest
 * Runs every 5 minutes. Batches all unsent portal notifications into
 * one digest email per client. Prevents email spam when multiple events
 * happen in quick succession (messages, documents, invoices).
 *
 * Only processes notifications older than 2 minutes (batching window).
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()
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
    // Recipients we could not resolve to an email (no portal access / no
    // address on file). Their notifications are marked email_sent_at anyway —
    // an unreachable notification must not recycle through this query every
    // 5 minutes forever (the pre-2026-06-11 behavior). Counted per reason for
    // the cron log so silent skips stay visible.
    const skipped: Record<string, number> = {}
    const markSkipped = async (reason: string, notifIds: string[]) => {
      skipped[reason] = (skipped[reason] ?? 0) + notifIds.length
      await supabaseAdmin
        .from('portal_notifications')
        .update({ email_sent_at: new Date().toISOString() })
        .in('id', notifIds)
    }

    // Per-type display config: code defaults + runtime overrides (app_settings).
    const typeLabels = mergeTypeLabels(
      await getAppSetting<Record<string, unknown>>('portal_digest_type_labels', {})
    )

    for (const [key, notifications] of Array.from(groups.entries())) {
      const [type, id] = key.split(':')
      const notifIds = notifications.map(n => n.id)

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
          .select('email, full_name, gender, language, portal_tier')
          .eq('id', id)
          .single()

        if (!contact?.email) { await markSkipped('contact_no_email', notifIds); continue }
        // Skip if contact has no portal access
        if (!contact.portal_tier || contact.portal_tier === 'none') { await markSkipped('contact_no_portal', notifIds); continue }

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
        // account-based: check if account has portal access
        const { data: acctCheck } = await supabaseAdmin
          .from('accounts')
          .select('portal_account')
          .eq('id', id)
          .single()
        if (!acctCheck?.portal_account) { await markSkipped('account_no_portal', notifIds); continue }

        // Get company email (communication_email or primary contact fallback)
        const companyEmail = await getCompanyEmail(id)
        if (!companyEmail) { await markSkipped('account_no_email', notifIds); continue }
        contactEmail = companyEmail

        // Still need contact details for greeting personalization
        const { data: links } = await supabaseAdmin
          .from('account_contacts')
          .select('contact_id')
          .eq('account_id', id)
          .limit(1)

        if (links?.length) {
          const { data: contact } = await supabaseAdmin
            .from('contacts')
            .select('full_name, gender, language')
            .eq('id', links[0].contact_id)
            .single()

          _contactName = contact?.full_name ?? null
          firstName = contact?.full_name?.split(' ')[0] || null
          gender = contact?.gender ?? null
          language = contact?.language ?? null
        }

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

      // No-double-notify rule for new-document alerts: a client with the PWA
      // installed already got a push when the doc was published, so skip those
      // from the digest email (they're still marked email_sent_at below so the
      // cron doesn't reprocess them). Other notification types are unaffected.
      let hasPush = false
      {
        const pushQuery = supabaseAdmin
          .from('push_subscriptions')
          .select('id', { count: 'exact', head: true })
        const { count } = type === 'account'
          ? await pushQuery.eq('account_id', id)
          : await pushQuery.eq('contact_id', id)
        hasPush = !!count && count > 0
      }
      const emailNotifs = notifications.filter(n => !(n.type === 'new_document' && hasPush))

      // Build per-type sections (pure helper — lib/portal/digest-render.ts).
      // Types with show_body (documents) render the file name under the title.
      const isItalian = language === 'Italian' || language === 'it'
      const sections = buildDigestSections(emailNotifs, typeLabels, isItalian)

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
      const totalCount = emailNotifs.length
      const subject = isItalian
        ? `${totalCount} nuov${totalCount === 1 ? 'o aggiornamento' : 'i aggiornamenti'} nel tuo portale`
        : `${totalCount} new update${totalCount === 1 ? '' : 's'} in your portal`

      // Send email — skipped entirely if every pending item was push-delivered
      // (e.g. a PWA client whose only updates are new-document alerts).
      if (emailNotifs.length > 0) {
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
      }

      // Mark all notifications as email-sent (including push-skipped new_document)
      await supabaseAdmin
        .from('portal_notifications')
        .update({ email_sent_at: new Date().toISOString() })
        .in('id', notifIds)

      notificationsProcessed += notifIds.length
    }

    logCron({
      endpoint: '/api/cron/portal-digest',
      status: 'success',
      duration_ms: Date.now() - startTime,
      details: { emails_sent: emailsSent, notifications_processed: notificationsProcessed, skipped },
    })

    return NextResponse.json({
      message: `Digest sent`,
      emails_sent: emailsSent,
      notifications_processed: notificationsProcessed,
      skipped,
    })
  } catch (err) {
    console.error('[portal-digest] Error:', err)
    logCron({
      endpoint: '/api/cron/portal-digest',
      status: 'error',
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Digest failed' }, { status: 500 })
  }
}
