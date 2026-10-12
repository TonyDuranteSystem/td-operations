/**
 * Bank application intake — the "send the submitted form to" addresses chosen when a link is made.
 * Pure + client-safe (the Forms page and the create route share it).
 */

export const BOFA_MAX_RECIPIENTS = 5

export type RecipientsResult = { ok: true; emails: string[] } | { ok: false; error: string }

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

/** Accepts a string (separated by commas, semicolons, spaces or new lines) or an array of strings. */
export function parseRecipients(raw: unknown): RecipientsResult {
  const parts: string[] = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : typeof raw === "string"
      ? raw.split(/[\s,;]+/)
      : []
  const seen = new Set<string>()
  const emails: string[] = []
  for (const part of parts) {
    const e = part.trim().toLowerCase()
    if (!e) continue
    if (e.length > 254 || !EMAIL_RE.test(e)) return { ok: false, error: `"${part.trim()}" is not a valid email address.` }
    if (seen.has(e)) continue
    seen.add(e)
    emails.push(e)
  }
  if (emails.length > BOFA_MAX_RECIPIENTS) {
    return { ok: false, error: `Use at most ${BOFA_MAX_RECIPIENTS} email addresses.` }
  }
  return { ok: true, emails }
}
