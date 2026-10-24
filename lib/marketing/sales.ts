/**
 * TD Marketing — payment links and sales (pure; dev job 9aec66fa). No database here: these functions decide, the server file writes.
 * Money is whole cents + a currency. Two currencies are never added together (every total is per currency).
 * The split in force when the link is made is COPIED onto the sale; a later change of terms never rewrites a past sale.
 */
import { splitCents, termInForce, shareBase, type CommissionTerm } from "@/lib/marketing/commission"

export type SaleStatus = "link_created" | "paid" | "refunded" | "partly_refunded" | "failed" | "expired"

export interface SaleRow {
  id: string
  team_id: string
  lead_id: string
  kind: string
  amount_cents: number
  currency: string
  note: string | null
  status: SaleStatus
  created_by: string
  created_by_user_id: string | null
  term_id: string | null
  seller_pct: number | null
  td_pct: number | null
  term_basis: string | null
  payee_account_id: string | null
  seller_cents: number | null
  td_cents: number | null
  stripe_session_id: string | null
  stripe_payment_intent: string | null
  checkout_url: string | null
  link_expires_at: string | null
  paid_at: string | null
  paid_amount_cents: number | null
  refunded_at: string | null
  refunded_cents: number
  needs_attention: string | null
  paid_out_at: string | null
  paid_out_reference: string | null
  paid_out_by: string | null
  created_at: string
}

/** What the link form sends. The amount is what a person types ("1500", "1,500.50"); it becomes cents here, never as a float. */
export interface LinkInput { kind: string; amount: string | number; currency: string; note?: string | null; confirmed?: boolean }

export interface LinkSettings {
  kinds: readonly { key: string; label: string }[]
  currencies: readonly string[]
  confirmAbove: number | null
}

/** "1,500.50" / "1500" / 1500.5 -> cents; null when it is not a plain positive amount with at most 2 decimals. */
export function parseAmountToCents(raw: string | number): number | null {
  const s = (typeof raw === "number" ? String(raw) : raw).trim().replace(/[\s,]/g, "")
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ""] = s.split(".")
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function formatMoney(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined) return "—"
  const major = cents / 100
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(major)
  } catch {
    return `${currency} ${major.toFixed(2)}`
  }
}

export interface SaleSnapshot {
  term_id: string | null
  seller_pct: number | null
  td_pct: number | null
  term_basis: string | null
  payee_account_id: string | null
  seller_cents: number | null
  td_cents: number | null
}

const NOT_SET: SaleSnapshot = { term_id: null, seller_pct: null, td_pct: null, term_basis: null, payee_account_id: null, seller_cents: null, td_cents: null }

/**
 * The split to save with a new sale. No term in force = "terms not set" (every field null) and Antonio applies terms later.
 * Only the "share of what was paid" basis is computed today; a net-of-fees term cannot be computed before Stripe's fee is known,
 * so it is saved as the term but with no amounts (they stay empty until Antonio applies the terms).
 */
export function snapshotForSale(
  terms: readonly CommissionTerm[],
  q: { teamId: string; kind: string; personRef: string | null; amountCents: number; at: Date },
): SaleSnapshot {
  const term = termInForce(terms, { teamId: q.teamId, kind: q.kind, personRef: q.personRef, at: q.at })
  if (!term) return { ...NOT_SET }
  const base = {
    term_id: term.id, seller_pct: term.seller_pct, td_pct: term.td_pct, term_basis: term.basis, payee_account_id: term.payee_account_id,
  }
  if (term.basis !== "amount_paid") return { ...base, seller_cents: null, td_cents: null }
  const b = shareBase(term, q.amountCents, 0)
  const split = b === null ? null : splitCents(b, term.seller_pct)
  return { ...base, seller_cents: split?.sellerCents ?? null, td_cents: split?.tdCents ?? null }
}

export type LinkPlan =
  | { ok: true; amountCents: number; currency: string; kind: string; note: string | null }
  | { ok: false; error: string; needsConfirm?: boolean }

/** Validate a new payment link request against the settings. */
export function planLink(input: LinkInput, s: LinkSettings): LinkPlan {
  if (!s.kinds.some(k => k.key === input.kind)) return { ok: false, error: "Pick what kind of sale this is." }
  const currency = String(input.currency ?? "").toUpperCase()
  if (!s.currencies.includes(currency)) return { ok: false, error: `${currency || "That currency"} is not allowed. Pick one from the list.` }
  const cents = parseAmountToCents(input.amount)
  if (cents === null) return { ok: false, error: "Type the amount as a number, for example 1500 or 1500.50." }
  if (s.confirmAbove !== null && cents / 100 > s.confirmAbove && input.confirmed !== true) {
    return { ok: false, needsConfirm: true, error: `This is more than ${formatMoney(Math.round(s.confirmAbove * 100), currency)}. Please confirm the amount is right.` }
  }
  const note = (input.note ?? "").trim().slice(0, 300)
  return { ok: true, amountCents: cents, currency, kind: input.kind, note: note || null }
}

/** The stage a lead moves to when its sale is paid, from the sale_kind_stages setting; null when none is set or the stage does not exist. */
export function stageForPaidSale(kind: string, map: Record<string, string>, stages: readonly { key: string }[]): string | null {
  const key = map[kind]
  return key && stages.some(s => s.key === key) ? key : null
}

export interface PaidFacts { sessionId: string; paymentIntent: string | null; amountCents: number | null; currency: string | null; paymentStatus?: string | null; at: Date }

export type PaidPlan =
  | { action: "ignore"; reason: string }
  | { action: "record"; patch: Record<string, unknown> }

/**
 * What to do when Stripe says a link was paid. Idempotent by design: a sale that is already past "link created" is left alone
 * (Stripe retries events), and a different session id never marks it paid.
 */
export function planPaid(sale: Pick<SaleRow, "status" | "stripe_session_id" | "amount_cents" | "currency" | "seller_cents">, f: PaidFacts): PaidPlan {
  if (sale.stripe_session_id !== f.sessionId) return { action: "ignore", reason: "session does not belong to this sale" }
  if (sale.status === "paid" || sale.status === "refunded" || sale.status === "partly_refunded") return { action: "ignore", reason: "already recorded" }
  if (f.paymentStatus && f.paymentStatus !== "paid") return { action: "ignore", reason: "not paid yet" }
  const patch: Record<string, unknown> = {
    status: "paid", paid_at: f.at.toISOString(), paid_amount_cents: f.amountCents, stripe_payment_intent: f.paymentIntent, updated_at: f.at.toISOString(),
  }
  const differs = f.amountCents !== sale.amount_cents || (f.currency ?? "").toUpperCase() !== sale.currency
  if (differs) patch.needs_attention = `Stripe reports ${formatMoney(f.amountCents, (f.currency ?? sale.currency).toUpperCase())} but the link was for ${formatMoney(sale.amount_cents, sale.currency)}. Check before paying out.`
  return { action: "record", patch }
}

export type RefundPlan = { action: "ignore"; reason: string } | { action: "record"; patch: Record<string, unknown> }

/**
 * A refund came back from Stripe. Full refund: the sale is "refunded" and both shares leave the totals. Partial refund: flagged for
 * Antonio, shares unchanged (nothing is clawed back automatically). Already paid-out sales are flagged either way.
 */
export function planRefund(sale: Pick<SaleRow, "status" | "amount_cents" | "currency" | "refunded_cents" | "paid_out_at">, refundedCents: number, at: Date): RefundPlan {
  if (!Number.isInteger(refundedCents) || refundedCents <= 0) return { action: "ignore", reason: "no refund amount" }
  if (sale.status !== "paid" && sale.status !== "partly_refunded") return { action: "ignore", reason: "sale is not a paid one" }
  if (refundedCents <= sale.refunded_cents) return { action: "ignore", reason: "already recorded" }
  const full = refundedCents >= sale.amount_cents
  const patch: Record<string, unknown> = {
    status: full ? "refunded" : "partly_refunded", refunded_cents: refundedCents, refunded_at: at.toISOString(), updated_at: at.toISOString(),
  }
  const parts: string[] = []
  if (!full) parts.push(`Partly refunded: ${formatMoney(refundedCents, sale.currency)} of ${formatMoney(sale.amount_cents, sale.currency)}. The split is unchanged; decide what to do.`)
  if (sale.paid_out_at) parts.push("The seller's share was already paid out; nothing is taken back automatically.")
  if (parts.length) patch.needs_attention = parts.join(" ")
  return { action: "record", patch }
}

/** A link nobody paid before its stored expiry: shown as "Link expired", never counted as an open link. */
export const isExpiredLink = (s: Pick<SaleRow, "status" | "link_expires_at">, now: Date = new Date()) =>
  s.status === "link_created" && s.link_expires_at !== null && new Date(s.link_expires_at).getTime() < now.getTime()

/** Sales that count as money received (paid, or partly refunded). A refunded, failed, expired or still-open link is not money. */
export const isReceived = (s: Pick<SaleRow, "status">) => s.status === "paid" || s.status === "partly_refunded"

export interface CurrencyTotals { currency: string; receivedCents: number; sellerCents: number; tdCents: number; owedToSellerCents: number; paidOutCents: number; unsetCount: number; openLinks: number; refundedCount: number }

/**
 * The currency the seller's company is paid in, when it is not the sale's own (Antonio's ruling 2026-10-23: Rocco's company is always
 * paid, and invoices, in dollars, with the SAME number as the euro amount received — no exchange rate). Empty = the sale's own currency.
 * True only when the seller's share leaves the sale's currency card.
 */
export function sellerPaidInOtherCurrency(saleCurrency: string, payoutCurrency?: string | null): boolean {
  return !!payoutCurrency && payoutCurrency !== saleCurrency
}

/** Per-currency totals. Sales with "terms not set" count as received but have no shares until terms are applied. With a payout currency, the seller's amounts of other-currency sales are left out of the card (see `payoutTotals`). */
export function totalsByCurrency(sales: readonly SaleRow[], now: Date = new Date(), payoutCurrency?: string | null): CurrencyTotals[] {
  const map = new Map<string, CurrencyTotals>()
  const get = (c: string) => {
    let t = map.get(c)
    if (!t) { t = { currency: c, receivedCents: 0, sellerCents: 0, tdCents: 0, owedToSellerCents: 0, paidOutCents: 0, unsetCount: 0, openLinks: 0, refundedCount: 0 }; map.set(c, t) }
    return t
  }
  for (const s of sales) {
    const t = get(s.currency)
    if (s.status === "link_created") { if (!isExpiredLink(s, now)) t.openLinks += 1; continue }
    if (s.status === "refunded") { t.refundedCount += 1; continue }
    if (!isReceived(s)) continue
    t.receivedCents += s.paid_amount_cents ?? s.amount_cents
    if (s.seller_cents === null || s.td_cents === null) { t.unsetCount += 1; continue }
    t.tdCents += s.td_cents
    if (sellerPaidInOtherCurrency(s.currency, payoutCurrency)) continue
    t.sellerCents += s.seller_cents
    if (s.paid_out_at) t.paidOutCents += s.seller_cents
    else t.owedToSellerCents += s.seller_cents
  }
  return Array.from(map.values()).sort((a, b) => a.currency.localeCompare(b.currency))
}

export interface PayoutTotals { currency: string; sellerCents: number; owedCents: number; paidOutCents: number }

/**
 * What the seller's company is owed / was paid, in its payout currency. The number is the same as the share in the sale's currency
 * (no conversion). Only sales whose currency differs from the payout currency are included here; the others stay in their own card.
 * Null when no payout currency is set or nothing qualifies.
 */
export function payoutTotals(sales: readonly SaleRow[], payoutCurrency?: string | null): PayoutTotals | null {
  if (!payoutCurrency) return null
  const t: PayoutTotals = { currency: payoutCurrency, sellerCents: 0, owedCents: 0, paidOutCents: 0 }
  let any = false
  for (const s of sales) {
    if (!isReceived(s) || s.status === "refunded" || s.status === "link_created") continue
    if (s.seller_cents === null || s.td_cents === null) continue
    if (!sellerPaidInOtherCurrency(s.currency, payoutCurrency)) continue
    any = true
    t.sellerCents += s.seller_cents
    if (s.paid_out_at) t.paidOutCents += s.seller_cents
    else t.owedCents += s.seller_cents
  }
  return any ? t : null
}

/** The plain word shown for a sale's status. */
export function saleStatusLabel(s: Pick<SaleRow, "status" | "paid_out_at" | "seller_cents"> & { link_expires_at?: string | null }): string {
  if (s.status === "link_created") return isExpiredLink({ status: s.status, link_expires_at: s.link_expires_at ?? null }) ? "Link expired" : "Link sent"
  if (s.status === "paid") return s.seller_cents === null ? "Paid · terms not set" : s.paid_out_at ? "Paid · paid out" : "Paid"
  if (s.status === "partly_refunded") return "Partly refunded"
  if (s.status === "refunded") return "Refunded"
  if (s.status === "expired") return "Link expired"
  return "Failed"
}

/** Can Antonio mark this sale paid out? Only a paid, split, not-yet-paid-out sale. */
export function canPayOut(s: Pick<SaleRow, "status" | "seller_cents" | "paid_out_at">): boolean {
  return (s.status === "paid" || s.status === "partly_refunded") && s.seller_cents !== null && s.paid_out_at === null
}

/** Re-split a "terms not set" sale with the term in force at `at` (Antonio's choice: today's terms). Null when it cannot be computed. */
export function applyTermToSale(sale: Pick<SaleRow, "amount_cents" | "paid_amount_cents" | "kind">, terms: readonly CommissionTerm[], teamId: string, personRef: string | null, at: Date): SaleSnapshot | null {
  const snap = snapshotForSale(terms, { teamId, kind: sale.kind, personRef, amountCents: sale.paid_amount_cents ?? sale.amount_cents, at })
  return snap.term_id && snap.seller_cents !== null ? snap : null
}
