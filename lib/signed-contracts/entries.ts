/**
 * Turns the rows the loader fetched into the lines the card shows. Pure (no database), so every rule here is unit-tested.
 *
 * Rules (the approved mockup):
 *  - one line per signed OFFER; if the same offer was signed more than once, only the newest file is listed;
 *  - newest signing first;
 *  - the amounts are shown as saved: contract rows show January / June / the saved yearly figure, renewals show the
 *    saved text of the annual agreement;
 *  - nothing here reads a passport number or an address: the row types below do not carry them.
 */
import { displayContractAmounts, readContractAmounts } from './contract-amounts'
import { formatSavedNumber } from './amount-input'
import { contractLabel, hasInstallmentAmounts } from './labels'
import { amountFromSavedText, readRenewalAmounts } from './renewal-amounts'
import type { AmountsView, SignedContractEntry } from './types'

export interface OfferRow {
  id: string
  token: string
  contract_type: string | null
  installment_currency: string | null
  recurring_costs: unknown
  account_id: string | null
}
export interface ContractRow {
  id: string
  offer_token: string
  signed_at: string | null
  created_at: string | null
  updated_at: string | null
  contract_version: string | null
  annual_fee: string | null
  installments: unknown
  pdf_path: string | null
}
export interface AgreementRow {
  token: string
  agreement_year: number | null
  cost_summary: unknown
  updated_at: string | null
}
export interface CorrectionRow {
  record_id: string
  created_at: string
  details: { by_name?: string; by?: string; was_text?: string } | null
}

/** The newest signing row of each offer (a retry or re-sign adds rows to the same offer). */
export function newestPerOffer(rows: ContractRow[]): ContractRow[] {
  const sorted = [...rows].sort((a, b) => {
    const byDate = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
    return byDate !== 0 ? byDate : b.id.localeCompare(a.id)
  })
  const seen = new Set<string>()
  const out: ContractRow[] = []
  for (const r of sorted) {
    if (seen.has(r.offer_token)) continue
    seen.add(r.offer_token)
    out.push(r)
  }
  return out
}

const symbolFromCurrency = (c: unknown): string => (c === 'USD' ? '$' : c === 'EUR' ? '€' : '')

/** "$" / "€" from the offer when it says; never guessed. */
export function currencySymbolOf(offer: Pick<OfferRow, 'installment_currency' | 'recurring_costs'>): string {
  const direct = symbolFromCurrency(offer.installment_currency)
  if (direct) return direct
  const first = Array.isArray(offer.recurring_costs) ? (offer.recurring_costs[0] as { currency?: unknown; price?: unknown; amount?: unknown } | undefined) : undefined
  const fromEntry = symbolFromCurrency(first?.currency)
  if (fromEntry) return fromEntry
  const text = String(first?.price ?? first?.amount ?? '').trim().charAt(0)
  return text === '$' || text === '€' ? text : ''
}

/** A recorded path the open route could sign (same rule as normalizeStoragePath, kept here so this file stays free of storage code). */
export function hasUsablePath(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false
  const p = path.replace(/^\/+/, '').trim()
  return p !== '' && !p.includes('..') && !p.includes('\\')
}

function newestCorrection(corrections: CorrectionRow[], id: string): SignedContractEntry['correction'] {
  const mine = corrections.filter((c) => c.record_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (!mine) return null
  return { byName: mine.details?.by_name || mine.details?.by || 'a team member', at: mine.created_at, wasText: mine.details?.was_text ?? '' }
}

export function buildEntries(input: {
  offers: OfferRow[]
  contracts: ContractRow[]
  agreements: AgreementRow[]
  corrections: CorrectionRow[]
}): SignedContractEntry[] {
  const offerByToken = new Map(input.offers.map((o) => [o.token, o]))
  const agreementByToken = new Map(input.agreements.map((a) => [a.token, a]))
  const entries: SignedContractEntry[] = []

  for (const c of newestPerOffer(input.contracts)) {
    const offer = offerByToken.get(c.offer_token)
    if (!offer) continue
    const type = offer.contract_type
    const agreement = type === 'renewal' ? agreementByToken.get(c.offer_token) : undefined
    const label = contractLabel(type, agreement?.agreement_year ?? (c.signed_at ? new Date(c.signed_at).getUTCFullYear() : null))
    let symbol = currencySymbolOf(offer)

    let amounts: AmountsView | null = null
    let amountsEditable = false
    let editStart: SignedContractEntry['editStart'] = null
    let source: SignedContractEntry['source'] = 'contract'
    let updatedAt: string | null = c.updated_at

    if (type === 'renewal') {
      source = 'agreement'
      updatedAt = agreement?.updated_at ?? null
      if (agreement) {
        const r = readRenewalAmounts(agreement.cost_summary)
        // the agreement's own text says which currency it was written in
        const written = (r.january ?? '').trim().charAt(0)
        if (written === '$' || written === '€') symbol = written
        if (r.layout === 'other') {
          amounts = { kind: 'lines', lines: r.lines.length ? r.lines : ['nothing saved'] }
        } else {
          amounts = { kind: 'jan-jun', january: r.january ?? 'nothing saved', june: r.june ?? 'nothing saved', yearly: null }
          amountsEditable = r.editable
          editStart = r.editable
            ? {
                january: String(amountFromSavedText(r.january) ?? r.january ?? ''),
                june: String(amountFromSavedText(r.june) ?? r.june ?? ''),
              }
            : null
        }
      } else {
        amounts = { kind: 'lines', lines: ['nothing saved'] }
      }
    } else if (hasInstallmentAmounts(type)) {
      const saved = readContractAmounts(c.annual_fee, c.installments)
      if (saved.unreadable) {
        amounts = { kind: 'lines', lines: [`installments saved as: ${typeof c.installments === 'string' ? c.installments : JSON.stringify(c.installments)}`, ...(saved.yearlyRaw ? [`yearly saved as: ${saved.yearlyRaw}`] : [])] }
      } else {
        const d = displayContractAmounts(saved, symbol)
        amounts = { kind: 'jan-jun', january: d.january, june: d.june, yearly: d.yearly }
      }
      amountsEditable = true
      editStart = {
        january: saved.january != null ? String(saved.january) : '',
        june: saved.june != null ? String(saved.june) : '',
      }
    }

    entries.push({
      id: c.id,
      offerToken: c.offer_token,
      contractType: type,
      chip: label.chip,
      title: label.title,
      signedAt: c.signed_at,
      version: c.contract_version,
      source,
      amounts,
      amountsEditable,
      editStart,
      symbol,
      fileAvailable: hasUsablePath(c.pdf_path),
      correction: newestCorrection(input.corrections, c.id),
      updatedAt,
    })
  }

  return entries.sort((a, b) => String(b.signedAt ?? '').localeCompare(String(a.signedAt ?? '')))
}

/** "January $1,250 · June $1,250" — the line written into the history so the old value can be shown later (as saved, never rounded). */
export function amountsText(january: number | null, june: number | null, symbol: string): string {
  const j = (n: number | null) => (n == null ? 'nothing saved' : `${symbol}${formatSavedNumber(n)}`)
  return `January ${j(january)} · June ${j(june)}`
}
