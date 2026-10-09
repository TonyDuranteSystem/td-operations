/**
 * Safe building blocks for the invoice + reminder emails (dev job 1a23f5f1, council review 2026-10-09).
 *
 * These emails go out from Tony Durante's own mailbox with text the CLIENT typed (company name, customer name,
 * payment terms, bank fields, payment link). Before this module that text was pasted straight into the HTML, so a
 * client could inject links or markup and phish their customers from our domain, and a line break in a name or email
 * could add headers (Bcc:, ...) to the message.
 *
 *  - every value that goes INTO html passes through `esc` (escape each field BEFORE joining them with <br/>);
 *  - every value that goes into a mail HEADER passes through `headerSafe` (no CR/LF/control characters);
 *  - the display name is RFC 2047 encoded (R041: no raw non-ASCII in headers) and quoted;
 *  - the attachment name is reduced to safe characters.
 */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Removes anything that could end a header line or start a new one. */
export function headerSafe(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
}

/** `"=?utf-8?B?...?=" <address>` — safe for any company name, including accents, quotes and commas. */
export function fromHeader(displayName: string, address: string): string {
  const name = headerSafe(displayName) || 'Invoices'
  const encoded = `=?utf-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`
  return `${encoded} <${headerSafe(address)}>`
}

/** Characters allowed in an attachment filename. */
export function safeFilename(name: string, fallback = 'invoice'): string {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 80)
  return cleaned || fallback
}

const ADDRESS_RE = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/

/** One plain address, no names, no lists, no control characters. */
export function isSafeRecipient(value: string | null | undefined): boolean {
  const v = String(value ?? '').trim()
  return v.length > 3 && v.length <= 254 && ADDRESS_RE.test(v)
}

export interface RawEmailInput {
  from: string            // already a safe header (use fromHeader)
  to: string              // already validated with isSafeRecipient
  subject: string
  html: string
  replyTo?: string
  attachment?: { base64: string; filename: string }
}

/** Gmail "raw" message (base64url). The subject is RFC 2047 encoded (R041). */
export function createRawEmail({ from, to, subject, html, replyTo, attachment }: RawEmailInput): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const contentType = attachment
    ? `multipart/mixed; boundary="${boundary}"`
    : `multipart/alternative; boundary="${boundary}"`

  const encodedSubject = `=?utf-8?B?${Buffer.from(headerSafe(subject)).toString('base64')}?=`
  const parts = [
    `From: ${from}`,
    `To: ${headerSafe(to)}`,
    ...(replyTo && isSafeRecipient(replyTo) ? [`Reply-To: ${headerSafe(replyTo)}`] : []),
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
  ]

  if (attachment) {
    const filename = safeFilename(attachment.filename.replace(/\.pdf$/i, '')) + '.pdf'
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment.base64,
    )
  }

  parts.push(`--${boundary}--`)
  return Buffer.from(parts.join('\r\n')).toString('base64url')
}

/** True when one of these exact subjects was already emailed to this person for this company within `windowSeconds`. */
export async function recentlyEmailed(
  db: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  args: { accountId: string | null; recipient: string; subjects: string[]; windowSeconds: number },
): Promise<boolean> {
  const since = new Date(Date.now() - args.windowSeconds * 1000).toISOString()
  let q = db.from('email_tracking').select('id', { head: true, count: 'exact' })
    .eq('recipient', args.recipient).in('subject', args.subjects).gte('created_at', since)
  q = args.accountId ? q.eq('account_id', args.accountId) : q.is('account_id', null)
  const { count } = await q
  return (count ?? 0) > 0
}
