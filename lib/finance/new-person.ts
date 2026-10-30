/**
 * A person who paid us but is not in the CRM — not a client, not a lead (Antonio, 2026-10-30:
 * "I want a system that I can invoice for someone that is not a client, that is not a lead. It's
 * something that I'm selling, and I need to issue an invoice").
 *
 * The Bank Feed's "Match to invoice" popup could only create an invoice for a company, person or
 * lead it had already FOUND by search; a payer nobody had ever recorded ended at "No matches". This is
 * the pure part of closing that gap: turn what the payment says about the payer into a plain
 * contact record and check what staff typed. The database work lives in lib/operations/.
 *
 * Pure: no database, no clock.
 */

const MAX_NAME = 120
const MIN_NAME = 2
const MAX_EMAIL = 254
// Deliberately loose: one @, something on both sides, a dot in the domain. Staff typed it; the point is
// to refuse obvious typos, not to police RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface NewPerson {
  full_name: string
  first_name: string
  last_name: string | null
  email: string | null
}

/** Lower-cased, trimmed address — or null when it is empty or not an address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null
  const e = value.trim().toLowerCase()
  if (!e || e.length > MAX_EMAIL || !EMAIL_RE.test(e)) return null
  return e
}

/** "Simone  Fattor" → first "Simone", last "Fattor". "Mary Ann Smith" → first "Mary", last "Ann Smith". */
export function splitPersonName(fullName: string): { first_name: string; last_name: string | null } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  return { first_name: parts[0] ?? "", last_name: parts.length > 1 ? parts.slice(1).join(" ") : null }
}

/**
 * What staff typed for the new person, checked. A name that is too short or too long, or an email
 * that is typed but not an address, is refused with a sentence the screen can show as it is.
 */
export function validateNewPerson(input: unknown): { ok: true; value: NewPerson } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Enter the person's name." }
  const raw = input as { full_name?: unknown; email?: unknown }

  const fullName = typeof raw.full_name === "string" ? raw.full_name.replace(/\s+/g, " ").trim() : ""
  if (fullName.length < MIN_NAME) return { ok: false, error: "Enter the person's name." }
  if (fullName.length > MAX_NAME) return { ok: false, error: `The name is too long (at most ${MAX_NAME} characters).` }

  const emailTyped = typeof raw.email === "string" ? raw.email.trim() : ""
  const email = emailTyped ? normalizeEmail(emailTyped) : null
  if (emailTyped && !email) return { ok: false, error: "That email address does not look right — fix it or leave it empty." }

  const { first_name, last_name } = splitPersonName(fullName)
  return { ok: true, value: { full_name: fullName, first_name, last_name, email } }
}

/**
 * The name to put in the "new person" box, taken from the payment. Processors write the payer as a
 * plain name ("Simone Fattor") or bury it in a longer line ("… From Digital nudge OU Via WISE …"); this
 * keeps what is after "From" up to "Via", else the first part of the line. Staff can edit it.
 * Empty when the line says nothing about a payer ("Unknown", a bare processor name).
 */
export function prefillPersonName(senderName: string | null | undefined, payerName?: string | null): string {
  const pick = (s: string | null | undefined) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "")
  const direct = pick(payerName)
  const line = direct || pick(senderName)
  if (!line) return ""

  const fromVia = /\bfrom\s+(.+?)\s+via\b/i.exec(line)
  let name = fromVia ? fromVia[1] : line.split(/[;|]/)[0].trim()
  name = name.replace(/\s*[—–-]\s*[0-9A-Z]{10,}.*$/, "").trim() // "Simone Fattor — 010F1102614929UT_1" → the reference is not the name
  name = name.replace(/\bmerchant name:.*$/i, "").trim()

  if (name.length < MIN_NAME || name.length > MAX_NAME) return ""
  if (/^(unknown|n\/a|none|-)$/i.test(name)) return ""
  return name
}
