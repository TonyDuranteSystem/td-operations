import { randomInt } from 'crypto'
import { CRM_BASE_URL } from '@/lib/config'

/**
 * Staff (CRM dashboard) credentials — temp-password generation + the email
 * that delivers it. Shared by "create team member" and "reset password" in
 * /api/team-management so the two can never drift apart.
 */

// No look-alike characters (0/O, 1/l/I) — the admin may read this aloud.
const LETTERS = 'abcdefghjkmnpqrstuvwxyz'
const DIGITS = '23456789'
const PASSWORD_ALPHABET = LETTERS + DIGITS

/**
 * Cryptographically random temp password, e.g. `TDx7kq9mdw2p!`.
 * Always contains at least one lowercase letter AND one digit (plus the fixed
 * `TD` capitals and `!`), so a strict password policy can never reject it.
 */
export function generateTempPassword(length = 10): string {
  const chars: string[] = []
  for (let i = 0; i < length; i++) {
    chars.push(PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)])
  }
  // Force one digit and one letter at two DIFFERENT positions.
  const digitAt = randomInt(length)
  let letterAt = randomInt(length - 1)
  if (letterAt >= digitAt) letterAt++
  chars[digitAt] = DIGITS[randomInt(DIGITS.length)]
  chars[letterAt] = LETTERS[randomInt(LETTERS.length)]
  return `TD${chars.join('')}!`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type StaffCredentialsKind = 'created' | 'reset'

export function buildStaffCredentialsEmail(params: {
  kind: StaffCredentialsKind
  fullName: string
  email: string
  tempPassword: string
  role?: 'admin' | 'team'
}): { subject: string; html: string } {
  const { kind, fullName, email, tempPassword, role } = params
  const loginUrl = `${CRM_BASE_URL}/login`
  const subject =
    kind === 'created' ? 'Your Tony Durante CRM Account' : 'Your Tony Durante CRM password was reset'
  const intro =
    kind === 'created'
      ? 'Your CRM dashboard account has been created. Here are your login credentials:'
      : 'Your CRM dashboard password was reset by an administrator. Here is your new temporary password:'
  const roleLine = role
    ? `<p style="color: #71717a; font-size: 12px; margin-top: 16px;">Role: ${role === 'admin' ? 'Administrator' : 'Team Member'}</p>`
    : ''

  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 18px;">Tony Durante — Team Access</h1>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <p>Hi ${escapeHtml(fullName)},</p>
          <p>${intro}</p>
          <div style="background: #18181b; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 0 0 8px; color: #ffffff; font-size: 15px;"><strong>Email:</strong> ${escapeHtml(email)}</p>
            <p style="margin: 0; color: #ffffff; font-size: 15px;"><strong>Temporary Password:</strong> <code style="background: #fef3c7; padding: 4px 8px; border-radius: 4px; font-size: 16px; font-weight: bold; color: #92400e;">${escapeHtml(tempPassword)}</code></p>
          </div>
          <p>Once you are logged in, please change it to your own password: click the key icon next to your name at the bottom of the left menu.</p>
          <a href="${loginUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 8px;">
            Login to CRM
          </a>
          ${roleLine}
        </div>
      </div>
    `
  return { subject, html }
}

/**
 * Send the credentials email. NEVER throws — returns `false` on failure so the
 * caller can tell the admin the email did not go out (before this existed a
 * failed send was only a console.error and the admin was told "sent").
 */
export async function sendStaffCredentialsEmail(
  params: Parameters<typeof buildStaffCredentialsEmail>[0],
): Promise<boolean> {
  try {
    const { gmailPost } = await import('@/lib/gmail')
    const { subject, html } = buildStaffCredentialsEmail(params)
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: Tony Durante <support@tonydurante.us>`,
      `To: ${params.email}`,
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
    return true
  } catch (err) {
    console.error('Staff credentials email failed:', err)
    return false
  }
}
