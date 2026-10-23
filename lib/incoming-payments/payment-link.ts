/**
 * Payment links made from the CRM lead page (incoming-payments Phase 2, dev job 40a58d9a). SERVER-ONLY except the pure parts.
 *
 * Antonio's rule: a link we make ourselves must SAY what it is, so the system never has to guess. Two purposes:
 *   paid_call  carries `payment_kind: paid_call` — when paid, the webhook records the paid call + a deductible credit by itself.
 *   other      carries NO label — when paid, it waits in Calendar → Payments to confirm (Phase 1) until staff say what it was.
 * Both carry `crm_lead_ref` (the lead) as plain bookkeeping. The amount, currency and description are FREE (never a fixed price list).
 */

export const LINK_PURPOSES = ["paid_call", "other"] as const
export type LinkPurpose = (typeof LINK_PURPOSES)[number]

/** Above this a tick "yes, this amount is right" is required (the route asks too: a script cannot skip it). Catches a typo like 3970 for 397. */
export const CONFIRM_ABOVE = 2000
export const MAX_AMOUNT = 50000
export const DEFAULT_DESCRIPTION = "Strategic call"
const DESCRIPTION_MAX = 80

export interface LinkRequest {
  leadId: string
  amountCents: number
  currency: "EUR" | "USD"
  description: string
  purpose: LinkPurpose
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** "397", "397.50", "1.234,50"-style input is NOT guessed: only a plain number with a dot or a comma as the decimal mark. */
export function parseAmountCents(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : ""
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(s)) return null
  const n = Number(s.replace(",", "."))
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null
  return Math.round(n * 100)
}

/** One flat shape (not a union): this project's TypeScript setup does not narrow a union on `ok`. `ok: false` always carries `error`. */
export interface ParsedLinkRequest {
  ok: boolean
  value?: LinkRequest
  needsConfirm?: boolean
  error?: string
}

export function parseLinkRequest(body: Record<string, unknown>): ParsedLinkRequest {
  const leadId = String(body.lead_id ?? "").trim()
  if (!UUID_RE.test(leadId)) return { ok: false, error: "That lead id is not valid." }
  const amountCents = parseAmountCents(body.amount)
  if (amountCents === null) return { ok: false, error: `Write the amount as a plain number, for example 397 or 397.50 (more than 0, at most ${MAX_AMOUNT}).` }
  const currency = String(body.currency ?? "").trim().toUpperCase()
  if (currency !== "EUR" && currency !== "USD") return { ok: false, error: "Pick EUR or USD." }
  const description = String(body.description ?? "").replace(/\s+/g, " ").trim() || DEFAULT_DESCRIPTION
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `The description can be at most ${DESCRIPTION_MAX} characters.` }
  const purpose = String(body.purpose ?? "paid_call").trim()
  if (!(LINK_PURPOSES as readonly string[]).includes(purpose)) return { ok: false, error: "Pick what this payment is for." }
  return {
    ok: true,
    value: { leadId, amountCents, currency, description, purpose: purpose as LinkPurpose },
    needsConfirm: amountCents / 100 > CONFIRM_ABOVE && body.confirmed !== true,
  }
}

/** The labels that travel on the Checkout Session AND the PaymentIntent. `other` deliberately carries no label key (see classify.ts). */
export function linkMetadata(req: Pick<LinkRequest, "leadId" | "purpose">, email: string | null): Record<string, string> {
  const meta: Record<string, string> = { crm_lead_ref: req.leadId }
  if (email) meta.client_email = email
  if (req.purpose === "paid_call") meta.payment_kind = "paid_call"
  return meta
}
