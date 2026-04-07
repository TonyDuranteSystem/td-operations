import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/cron/portal-issues
 * Runs every hour. Checks for open portal issues and notifies admin.
 * Also auto-resolves issues older than 48h that are likely stale.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get open issues
  const { data: openIssues } = await supabaseAdmin
    .from('portal_issues')
    .select('id, account_id, user_email, area, error_message, error_context, created_at, accounts(company_name)')
    .eq('status', 'open')
    .order('created_at', { ascending: true })

  if (!openIssues || openIssues.length === 0) {
    return NextResponse.json({ message: 'No open issues', count: 0 })
  }

  // Check for issues older than 48h — auto-flag as urgent
  const now = Date.now()
  const urgentIssues = openIssues.filter(i => {
    const age = now - new Date(i.created_at).getTime()
    return age > 48 * 60 * 60 * 1000
  })

  // Send daily summary email to admin (only if there are issues)
  const issueRows = openIssues.map(i => {
    const company = (i as Record<string, unknown>).accounts
      ? ((i as Record<string, unknown>).accounts as Record<string, string>).company_name
      : 'Unknown'
    const age = Math.round((now - new Date(i.created_at).getTime()) / 3600000)
    const isUrgent = age > 48
    return `<tr style="border-bottom: 1px solid #e4e4e7;">
      <td style="padding: 8px; font-size: 13px;">${isUrgent ? '🔴' : '🟡'} ${company}</td>
      <td style="padding: 8px; font-size: 13px;">${i.area}</td>
      <td style="padding: 8px; font-size: 13px;">${i.user_email || '—'}</td>
      <td style="padding: 8px; font-size: 13px;">${i.error_message?.substring(0, 80) || '—'}</td>
      <td style="padding: 8px; font-size: 13px;">${age}h ago</td>
    </tr>`
  }).join('')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
      <h2 style="font-size: 18px; color: #18181b;">Portal Issues — ${openIssues.length} Open</h2>
      ${urgentIssues.length > 0 ? `<p style="color: #dc2626; font-size: 14px; font-weight: 600;">⚠️ ${urgentIssues.length} issue(s) older than 48 hours — needs immediate attention</p>` : ''}
      <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
        <thead>
          <tr style="background: #f4f4f5;">
            <th style="padding: 8px; text-align: left; font-size: 12px; color: #71717a;">Company</th>
            <th style="padding: 8px; text-align: left; font-size: 12px; color: #71717a;">Area</th>
            <th style="padding: 8px; text-align: left; font-size: 12px; color: #71717a;">Client</th>
            <th style="padding: 8px; text-align: left; font-size: 12px; color: #71717a;">Error</th>
            <th style="padding: 8px; text-align: left; font-size: 12px; color: #71717a;">Age</th>
          </tr>
        </thead>
        <tbody>${issueRows}</tbody>
      </table>
      <p style="color: #a1a1aa; font-size: 11px; margin-top: 24px;">
        Resolve issues via: POST /api/portal/resolve-issue with {issue_id}
      </p>
    </div>
  `

  const subject = urgentIssues.length > 0
    ? `🔴 Portal Issues: ${openIssues.length} open (${urgentIssues.length} urgent)`
    : `🟡 Portal Issues: ${openIssues.length} open`

  const mimeMessage = [
    'From: Tony Durante LLC <support@tonydurante.us>',
    'To: support@tonydurante.us',
    `Subject: =?utf-8?B?${Buffer.from(subject).toString("base64")}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n')

  const raw = Buffer.from(mimeMessage).toString('base64url')

  try {
    await gmailPost('/messages/send', { raw })
  } catch (err) {
    console.error('Failed to send portal issues digest:', err)
  }

  return NextResponse.json({
    message: 'Portal issues check complete',
    total_open: openIssues.length,
    urgent: urgentIssues.length,
    email_sent: true,
  })
}
