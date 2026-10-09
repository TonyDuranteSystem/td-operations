/**
 * Rules for the payment links a client prints on their invoices (dev job 1a23f5f1, council review 2026-10-09).
 *
 * A payment link is put inside an HTML email sent from Tony Durante's own mailbox and rendered as an <a href> in the
 * portal. An unchecked value could be `javascript:...`, or contain a quote that breaks out of the attribute and injects
 * markup. So: https only, a sane length, and none of the characters that can end an attribute or start a tag.
 */

export const GATEWAYS = ['stripe', 'paypal', 'other'] as const
export const CURRENCIES = ['USD', 'EUR'] as const

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string }

export function validatePaymentLinkUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'The payment link must be a web address.' }
  const url = raw.trim()
  if (url.length < 12 || url.length > 2000) return { ok: false, error: 'The payment link is too short or too long.' }
  if (/[\s"'<>`\\\u0000-\u001f]/.test(url)) return { ok: false, error: 'The payment link contains characters that are not allowed.' }
  let parsed: URL
  try { parsed = new URL(url) } catch { return { ok: false, error: 'The payment link is not a valid web address.' } }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'The payment link must start with https://' }
  if (!parsed.hostname.includes('.')) return { ok: false, error: 'The payment link is not a valid web address.' }
  return { ok: true, url: parsed.toString() }
}

/** Of the links left after a delete, the one that becomes the default: the oldest, so the choice is deterministic. */
export function pickNewDefault<T extends { id: string; created_at?: string | null }>(remaining: T[]): T | null {
  if (remaining.length === 0) return null
  return [...remaining].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0]
}
