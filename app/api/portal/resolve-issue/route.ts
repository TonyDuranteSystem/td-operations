import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'

/**
 * POST /api/portal/resolve-issue
 * Admin resolves a portal issue and optionally notifies the client via email.
 * Body: { issue_id, notify_client?: boolean, custom_message?: string }
 */
export async function POST(request: NextRequest) {
  // Simple auth check — this is an internal endpoint
  const authHeader = request.headers.get('authorization')
  const isBearer = authHeader?.startsWith('Bearer ')
  if (!isBearer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { issue_id, notify_client = true, custom_message } = await request.json()
  if (!issue_id) return NextResponse.json({ error: 'issue_id required' }, { status: 400 })

  // Get the issue
  const { data: issue } = await supabaseAdmin
    .from('portal_issues')
    .select('*, accounts(company_name)')
    .eq('id', issue_id)
    .single()

  if (!issue) return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
  if (issue.status === 'resolved') return NextResponse.json({ message: 'Already resolved' })

  // Mark as resolved
  await supabaseAdmin
    .from('portal_issues')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: 'admin',
      client_notified: notify_client,
      updated_at: new Date().toISOString(),
    })
    .eq('id', issue_id)

  // Send email to client
  if (notify_client && issue.user_email) {
    const companyName = (issue as Record<string, unknown>).accounts
      ? ((issue as Record<string, unknown>).accounts as Record<string, string>).company_name
      : 'your account'

    const areaLabels: Record<string, string> = {
      upload: 'document upload',
      invoice: 'invoice',
      general: 'portal',
    }
    const areaLabel = areaLabels[issue.area] || issue.area

    const message = custom_message || `The ${areaLabel} issue you experienced has been resolved. Please try again at your convenience.`

    const emailBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="font-size: 20px; font-weight: 600; color: #18181b; margin: 0;">Issue Resolved</h1>
        </div>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #166534; margin: 0; font-size: 14px;">&#10003; ${message}</p>
        </div>
        <p style="color: #71717a; font-size: 13px; line-height: 1.6;">
          If you continue to experience any issues, please don't hesitate to reach out via the chat in your portal.
        </p>
        <div style="margin-top: 28px; text-align: center;">
          <a href="https://portal.tonydurante.us/portal/documents" style="display: inline-block; background: #2563eb; color: white; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Go to Portal
          </a>
        </div>
        <p style="color: #a1a1aa; font-size: 11px; text-align: center; margin-top: 32px;">
          Tony Durante LLC — Client Services
        </p>
      </div>
    `

    const subject = `Issue Resolved — ${companyName}`
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`

    // Build MIME message
    const mimeMessage = [
      `From: Tony Durante LLC <support@tonydurante.us>`,
      `To: ${issue.user_email}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      emailBody,
    ].join('\r\n')

    const raw = Buffer.from(mimeMessage).toString('base64url')

    try {
      await gmailPost('/messages/send', { raw })
    } catch (err) {
      console.error('Failed to send resolution email:', err)
      // Don't fail the whole operation
    }
  }

  return NextResponse.json({ ok: true, notified: notify_client })
}
