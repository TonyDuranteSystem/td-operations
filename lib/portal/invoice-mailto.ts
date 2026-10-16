/**
 * "Send from my own email" (dev job 1a23f5f1, Antonio 2026-10-16): instead of our system emailing the invoice, the
 * client's own email program opens with the customer, subject and text ready, and the client attaches the PDF and
 * sends it from their own address. This builds that link. Pure, so it is tested without a browser.
 *
 * A mailto: link has a practical length limit (browsers and mail apps cut around 2,000 characters), so the body is
 * trimmed; the PDF carries the full details anyway.
 */

const MAX_BODY = 1400

/** One plain address or nothing: a mailto link with an odd recipient could address someone else. */
export function safeMailtoRecipient(email: string | null | undefined): string {
  const e = String(email ?? '').trim()
  return /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/.test(e) ? e : ''
}

export function buildMailtoUrl(input: { to?: string | null; subject: string; body: string }): string {
  const to = safeMailtoRecipient(input.to)
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim()
  let body = input.body.replace(/\r\n/g, '\n')
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY - 1).trimEnd() + '…'
  // encodeURIComponent keeps every character the mail app must not misread (&, ?, #, newlines) inert.
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
