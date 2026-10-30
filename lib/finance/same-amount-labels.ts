/**
 * The client-safe half of the Match popup's "already-paid invoices of exactly this amount" box: the types the
 * route returns and the plain words the box shows. No database here — the reader is lib/finance/same-amount-paid.ts
 * (server only), so the popup can import this file without pulling server code into the browser.
 *
 * Antonio, 2026-10-30, from a real €3,000 Stripe payment nobody could place: an invoice of exactly €3,000, already
 * marked Paid the same day and written to a person, had no bank payment tied to it — and nothing in the popup showed
 * it unless the payer was already known. The wording is deliberately honest: an amount and a date are a COINCIDENCE,
 * not proof, so the box never calls anything a match, and a single invoice is "the only one", not "the answer".
 */
import type { PayerInvoice } from "@/lib/finance/payer-invoices"

/** The everyday window — the same 3 days the automatic matcher uses to break a tie by paid date. */
export const SAME_AMOUNT_DAYS = 3
/** The "look wider" window, behind a link: about 1 in 5 right invoices was paid further than 3 days from the bank payment. */
export const SAME_AMOUNT_WIDER_DAYS = 30
/** How many invoices the box lists: a few for the everyday window, more (scrolling) for the wider one. */
export const MAX_SHOWN_NEAR = 8
export const MAX_SHOWN_WIDE = 30

/** An invoice in the box: the usual invoice row plus how far its paid day is from the bank payment. */
export type SameAmountInvoice = PayerInvoice & {
  /** Whole days from the bank payment to the day the invoice was paid (negative = paid before); null if unknown. */
  days_from_payment: number | null
}

export interface SameAmountPaidResult {
  ok: boolean
  error?: string
  /** False when nothing could be searched (no usable date, amount or currency): the box then says nothing at all. */
  searched?: boolean
  /** The window used, in days either side of the payment date. */
  days?: number
  /** The ones shown, closest paid date first. Never one that another bank payment is already tied to. */
  invoices?: SameAmountInvoice[]
  /** All that fit, before the cap and without the ones another bank payment has. */
  found?: number
  /** Fit, but another bank payment is already tied to them: left out, and counted so the box can say so. */
  already_tied?: number
}

/** The window asked for: 30 only when exactly 30 is asked, anything else is the everyday 3. */
export function normalizeDays(value: unknown): number {
  return Number(value) === SAME_AMOUNT_WIDER_DAYS ? SAME_AMOUNT_WIDER_DAYS : SAME_AMOUNT_DAYS
}

/** How many invoices the box lists for a window. */
export function shownCap(days: number): number {
  return days >= SAME_AMOUNT_WIDER_DAYS ? MAX_SHOWN_WIDE : MAX_SHOWN_NEAR
}

/** "same day", "1 day before", "3 days after" — empty when the day is unknown. */
export function dayOffsetText(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return ""
  if (days === 0) return "same day"
  const n = Math.abs(days)
  return `${n} day${n === 1 ? "" : "s"} ${days < 0 ? "before" : "after"}`
}

/**
 * The box's heading. Exactly one → "the only" (a strong coincidence, still not proof); several → how many, so nobody
 * reads one of five as the answer.
 */
export function sameAmountHeadline(found: number, days: number, amountText: string): string {
  const within = `within ${days} days of this payment`
  return found === 1
    ? `The only paid invoice of exactly ${amountText} ${within}`
    : `${found} paid invoices of exactly ${amountText} ${within}`
}

/** What the box says under the rows: nothing proves they belong to this payer. */
export const SAME_AMOUNT_CAUTION = "Only the amount and the date match — nothing here says they belong to this payer, so check before linking."

/** The line shown when nothing fits (the box stays visible only to offer the wider look, or to say there is none). */
export function sameAmountEmptyText(days: number, amountText: string): string {
  return `No paid invoice of exactly ${amountText} within ${days} days of this payment.`
}

/** "2 more were left out because another bank payment is already tied to them." — empty for none. */
export function sameAmountTiedText(n: number): string {
  if (!(n > 0)) return ""
  return `${n} more ${n === 1 ? "was" : "were"} left out because another bank payment is already tied to ${n === 1 ? "it" : "them"}.`
}

/**
 * Drop what the popup already shows elsewhere ("From who paid", the proposed-invoice banner), so one invoice is never
 * listed twice. Matches by id, and by invoice number for the banner (it has no id).
 */
export function dropAlreadyShown<T extends { id: string; invoice_number: string | null }>(
  invoices: readonly T[],
  shownIds: ReadonlySet<string>,
  shownNumber?: string | null,
): T[] {
  return invoices.filter((i) => !shownIds.has(i.id) && !(shownNumber && i.invoice_number && i.invoice_number === shownNumber))
}
