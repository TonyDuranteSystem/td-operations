/**
 * "Someone else is paying" — what the client may type on the payment page
 * (dev job e62bc2b6, Antonio 2026-11-21).
 *
 * This text is typed by a person on a public page and is then PRINTED on an invoice
 * PDF and used in emails, so it is cleaned hard: plain text only, short, no markup.
 * It is only ever a typed payer (name, address, country, VAT / tax code). The client
 * can NEVER pick one of our companies here — linking a typed name to a company in
 * the CRM is staff-only (Finance → Bill to), otherwise anyone could type another
 * client's company name and put an invoice into that client's books.
 */
import type { BillToEntityDetails } from "@/lib/offers/bill-to"

export const CLIENT_PAYER_LIMITS = { name: 120, address: 200, country: 80, vat_number: 40 } as const

/** Plain text: no control characters, no angle brackets, single spaces, trimmed, capped. */
export function cleanPayerText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const t = v.replace(/[\u0000-\u001F\u007F<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim()
  return t || null
}

export type ClientPayerResult = { details: BillToEntityDetails } | { error: string }

/** Validate the box. Only the name is required; everything else is optional. */
export function sanitizeClientPayer(raw: unknown): ClientPayerResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Please enter who is paying." }
  const r = raw as Record<string, unknown>
  const name = cleanPayerText(r.name, CLIENT_PAYER_LIMITS.name)
  if (!name || name.length < 2) return { error: "Please enter the name of who is paying." }
  return {
    details: {
      name,
      address: cleanPayerText(r.address, CLIENT_PAYER_LIMITS.address),
      country: cleanPayerText(r.country, CLIENT_PAYER_LIMITS.country),
      vat_number: cleanPayerText(r.vat_number, CLIENT_PAYER_LIMITS.vat_number),
    },
  }
}
