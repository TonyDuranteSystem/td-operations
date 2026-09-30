/**
 * Pure rules for signing an offer or renewal agreement ON THE SERVER (N0, dev job f907220c).
 *
 * Before N0 each of the four signing components wrote the database from the
 * browser with the public key. The server now does those writes; these functions
 * are the rules, kept pure so the exact behaviour of each component is pinned by
 * unit tests (tests/unit/public-signing.test.ts):
 *
 *   main       (formation MSA, contract/page.tsx)       status + payment_links cleared + wire amount
 *   service    (onboarding MSA, service-agreement.tsx)  status only
 *   standalone (tax return / ITIN / closure)             status only
 *   renewal    (annual agreement)                        annual_agreements, never offers
 */

import { computeOfferPayable } from '@/lib/offers/compute-offer-totals'

export type SignKind = 'main' | 'service' | 'standalone' | 'renewal'

/**
 * Which component signs this contract type — the SAME routing the contract page
 * has always used to pick the component (renewal → RenewalAgreement; tax_return,
 * itin, closure → StandaloneServiceAgreement; onboarding → ServiceAgreement;
 * everything else, including a missing type, → the formation MSA).
 */
export function signKindFor(contractType: string | null | undefined): SignKind {
  switch (contractType) {
    case 'renewal': return 'renewal'
    case 'tax_return':
    case 'itin':
    case 'closure': return 'standalone'
    case 'onboarding': return 'service'
    default: return 'main'
  }
}

/** Client-typed columns the browser may send for its contracts row. */
const CLIENT_TEXT_FIELDS = [
  'client_name', 'client_email', 'client_phone', 'client_address', 'client_city',
  'client_state', 'client_zip', 'client_country', 'client_nationality',
  'client_passport', 'client_passport_exp',
] as const

const MAX_TEXT = 500

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v.slice(0, MAX_TEXT)
}

/**
 * The contracts row fields the browser supplies, reduced to exactly what each
 * component has always written. The server adds offer_token, signed_at, pdf_path
 * and status itself — never from the request.
 */
export function sanitizeContractFields(
  input: Record<string, unknown> | null | undefined,
  kind: SignKind,
): Record<string, unknown> {
  const src = input && typeof input === 'object' ? input : {}
  const out: Record<string, unknown> = {}
  if (kind === 'standalone' || kind === 'renewal') {
    out.client_name = cleanText(src.client_name)
    out.client_email = cleanText(src.client_email)
    return out
  }
  for (const f of CLIENT_TEXT_FIELDS) out[f] = cleanText(src[f])
  out.llc_type = src.llc_type === 'MMLLC' || src.llc_type === 'SMLLC' ? src.llc_type : null
  out.annual_fee = typeof src.annual_fee === 'string' && /^\d+(\.\d+)?$/.test(src.annual_fee) ? src.annual_fee : null
  out.contract_year = typeof src.contract_year === 'string' && /^\d{4}$/.test(src.contract_year) ? src.contract_year : null
  let installments: string | null = null
  if (typeof src.installments === 'string') {
    try {
      const p = JSON.parse(src.installments)
      if (p && typeof p === 'object' && typeof p.jan === 'number' && typeof p.jun === 'number' && Number.isFinite(p.jan) && Number.isFinite(p.jun)) {
        installments = JSON.stringify({ jan: p.jan, jun: p.jun })
      }
    } catch { /* malformed → null */ }
  }
  out.installments = installments
  return out
}

/**
 * The offer columns the formation MSA rewrites at signing — moved verbatim from
 * the browser (contract/page.tsx), where the reasoning is documented:
 *   • payment_links cleared (checkout is created fresh after signing),
 *   • the wire amount becomes the NET amount DUE NOW (credit applied, first part of
 *     a payment plan only), across every agreement the client is signing,
 *   • when the plan disagrees with its own offer, NO new figure is quoted.
 * Only the 'main' kind rewrites anything; the other components flip status only.
 */
export function signingOfferUpdate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any,
  kind: SignKind,
): { update: Record<string, unknown>; planRefusal: string | null } {
  if (kind !== 'main') return { update: {}, planRefusal: null }
  const selected = asList(offer?.selected_services) as string[]
  const payable = computeOfferPayable(
    {
      services: asList(offer?.services) as never,
      cost_summary: asList(offer?.cost_summary) as never,
      selected_services: Array.from(new Set(selected)),
      currency: offer?.currency,
      credit_amount: offer?.credit_amount,
      payment_plan: offer?.payment_plan,
    },
    { currencyOverride: offer?.currency === 'USD' ? 'USD' : 'EUR' },
  )
  const symbol = offer?.currency === 'USD' ? '$' : '€'
  const total = payable.dueNow
  const update: Record<string, unknown> = { payment_links: null }
  if (total > 0 && offer?.bank_details && !payable.planRefusal) {
    update.bank_details = { ...offer.bank_details, amount: `${symbol}${total.toLocaleString('en-US')}` }
  }
  return { update, planRefusal: payable.planRefusal ?? null }
}

/** A JSONB list some legacy rows store as a JSON string (the pages have always parsed both). */
export function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

/** Offer statuses from which a client may sign. */
export const SIGNABLE_OFFER_STATUSES = ['draft', 'sent', 'published', 'viewed'] as const

/**
 * Why this offer cannot be signed right now, or null when it can. Mirrors the
 * gates the pages enforce in the browser, now enforced where it counts:
 *   • already signed/completed → handled by the caller as a RESUME, not an error,
 *   • expired (by status or by date), superseded, cancelled → refused,
 *   • a multi-option offer whose option is not yet picked → refused,
 *   • a split-payment choice not yet made (when there is an amount) → refused.
 */
export function offerSignRefusal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any,
  now: Date = new Date(),
): string | null {
  const status = String(offer?.status ?? '')
  if (!(SIGNABLE_OFFER_STATUSES as readonly string[]).includes(status)) {
    return status === 'expired' ? 'This offer has expired. Please contact us for a new one.'
      : status === 'superseded' ? 'This offer has been replaced by a newer version. Please use the latest link we sent you.'
      : 'This offer can no longer be signed. Please contact us.'
  }
  if (offer?.expires_at && new Date(offer.expires_at) < now) {
    return 'This offer has expired. Please contact us for a new one.'
  }
  if (Array.isArray(offer?.packages) && offer.packages.length > 0 && !offer.package_locked_at) {
    return 'Please choose one of the options on the offer page before signing.'
  }
  if (offer?.allow_split_payment_choice && !offer?.payment_choice_made_at) {
    const gate = computeOfferPayable({
      services: asList(offer.services) as never,
      cost_summary: asList(offer.cost_summary) as never,
      selected_services: asList(offer.selected_services) as string[],
      currency: offer.currency,
      credit_amount: offer.credit_amount,
      payment_plan: null,
    })
    if (gate.gross > 0) return 'Please choose how you want to pay on the offer page before signing.'
  }
  return null
}

/**
 * The client's ticks, validated against the offer's own lines. Keeps the stored
 * shape the pages have always written: every required (non-optional, one-off)
 * line plus the ticked optional lines. Returns null when a name is not a line of
 * this offer (refuse the request rather than guess).
 */
export function validateSelection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any,
  requested: unknown,
): string[] | null {
  if (!Array.isArray(requested)) return null
  const services = asList(offer?.services) as Array<{ name?: string; optional?: boolean }>
  const names = new Set(services.map((s) => s?.name).filter((n): n is string => typeof n === 'string'))
  const out: string[] = []
  for (const n of requested) {
    if (typeof n !== 'string' || !names.has(n)) return null
    if (!out.includes(n)) out.push(n)
  }
  // Required lines are never optional for the client — a list that drops one is
  // not a selection the page can have produced.
  for (const s of services) {
    if (s && !s.optional && typeof s.name === 'string' && !out.includes(s.name)) return null
  }
  return out
}

/** Server-built storage path for the signed PDF; always under the offer's own folder. */
export function signedPdfPathFor(token: string, kind: SignKind, now: number = Date.now()): string {
  const stem = kind === 'main' ? 'contract-signed'
    : kind === 'service' ? 'service-agreement-signed'
    : kind === 'standalone' ? 'tax-agreement-signed'
    : 'annual-agreement-signed'
  return `${token}/${stem}-${now}.pdf`
}

/** True when a client-reported path is one the server could have issued for this token. */
export function isOwnSignedPdfPath(token: string, path: unknown): path is string {
  if (typeof path !== 'string') return false
  if (!path.startsWith(`${token}/`)) return false
  const rest = path.slice(token.length + 1)
  return /^(contract|service-agreement|tax-agreement|annual-agreement)-signed-\d+\.pdf$/.test(rest)
}

export const WIRE_RECEIPT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] as const

export function wireReceiptPathFor(token: string, fileName: unknown, now: number = Date.now()): string | null {
  const raw = typeof fileName === 'string' ? fileName : ''
  // No extension (phones sometimes send none): name it .pdf — the file's REAL type is
  // checked from its first bytes when it is recorded, never from its name.
  const ext = raw.includes('.') ? (raw.split('.').pop() || 'pdf').toLowerCase() : 'pdf'
  if (!(WIRE_RECEIPT_EXTENSIONS as readonly string[]).includes(ext)) return null
  return `${token}/wire-receipt-${now}.${ext}`
}

export function isOwnWireReceiptPath(token: string, path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith(`${token}/`)) return false
  return /^wire-receipt-\d+\.(pdf|png|jpg|jpeg|heic|webp|gif)$/.test(path.slice(token.length + 1))
}
