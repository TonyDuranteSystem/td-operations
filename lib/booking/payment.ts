/**
 * Booking page, PAID links (Stage 3, dev job 74432428) — the small pure pieces everything else shares: the payment address, the money words, what state a paid link is
 * in, and the draft message Antonio sends. No database, no network, no clock.
 *
 * A paid link is a normal Calendly link plus a price. The person books a time FIRST, then pays on our own page /pay/b/<code> (the code is a random 128-bit id, separate
 * from the booking link's own id). Nothing here ever builds a Stripe address: the pay page makes the card page only when the payer clicks Pay, so the address
 * Antonio sends never expires.
 */

import { APP_BASE_URL } from "@/lib/config"
import { isStrictLinkId } from "@/lib/booking-links/id"
import { isItalian } from "@/lib/locale"
import type { PayMode } from "@/lib/booking/plan"

/** The public address of a paid link's payment page. */
export function payUrl(payCode: string, baseUrl: string = APP_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}/pay/b/${payCode}`
}

/**
 * A plain email address: one "@", no spaces and none of `, ; ? & = < > ( ) " '`. Stripe rejects a malformed address as the card page's prefilled email (which would make the
 * link unpayable), and a "?" or "&" in an address typed by a booker could add parts to a mail link: only a plain address is ever prefilled or put in a link.
 */
export function isPlainEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@,;?&=<>()"']+@[^\s@,;?&=<>()"']+\.[^\s@,;?&=<>()"']{2,}$/.test(v)
}

/**
 * An email a person may BOOK with: one "@", no spaces, and none of `< > ( ) " \ , ; :`. Unlike isPlainEmail it allows an apostrophe, "&", "=" and "?" (d'amico@x.it is a real address):
 * the booking goes to Calendly, which has the last word, and nothing here is ever put in a mail link or a Stripe prefill unless isPlainEmail also says yes (those two still use it).
 * The page's own check uses the same characters, so the button never enables for an address the server will refuse.
 */
export function isBookableEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@<>()"\\,;:]+@[^\s@<>()"\\,;:]+\.[^\s@<>()"\\,;:]{2,}$/.test(v)
}

/** Only a code of our exact shape is ever looked up. */
export const isPayCode = isStrictLinkId

/** "$397.00" / "€397.50". Never rounds: the cents are whole numbers already. */
export function moneyText(cents: number, currency: string): string {
  const symbol = currency.toUpperCase() === "EUR" ? "€" : "$"
  return `${symbol}${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export type PayState = "unpaid" | "paid" | "not_charging"

/** Where a paid link stands. Paid wins over "not charging" (money that arrived is never hidden). */
export function payStateOf(row: { paid_session_id?: string | null; not_charging_at?: string | null }): PayState {
  if (row.paid_session_id) return "paid"
  if (row.not_charging_at) return "not_charging"
  return "unpaid"
}

/** What the system will do with the money, in plain words (used in the maker's preview and on the card). */
export function payModeText(mode: PayMode): string {
  return mode === "credit"
    ? "Recorded as revenue, plus a credit of the same amount toward their next new service."
    : "Recorded as revenue only. The credit is already used up, so nothing comes off a later service."
}

/** Anything that is not exactly "credit" is revenue only (the safe side: never promises a credit nobody decided on). */
export function parsePayMode(raw: unknown): PayMode {
  return raw === "credit" ? "credit" : "revenue_only"
}

/** A booking-link row's payment columns (all null on a free link). */
export interface PayFacts {
  pay_amount_cents: number | null
  pay_currency: string | null
  pay_label: string | null
  pay_mode: string | null
  pay_code: string | null
  paid_session_id: string | null
  not_charging_at: string | null
}

export function isPaidLink(row: Pick<PayFacts, "pay_amount_cents" | "pay_currency" | "pay_code">): boolean {
  return typeof row.pay_amount_cents === "number" && row.pay_amount_cents > 0 && (row.pay_currency === "USD" || row.pay_currency === "EUR") && !!row.pay_code
}

export interface DraftInput {
  language: "Italian" | "English" | null
  /** the person's name, if known (only the first word is used in the greeting) */
  name: string | null
  amountText: string
  url: string
  /** the call's day and time already written in New York time ("Mon, Nov 16, 9:30 AM ET"), or null */
  when: string | null
}

/** The message Antonio sees before anything is sent. Written in the person's language; plain, no payment details beyond the amount and the address. */
export function paymentDraft(input: DraftInput): { subject: string; body: string } {
  const first = (input.name ?? "").trim().split(/\s+/)[0] ?? ""
  if (isItalian(input.language)) {
    return {
      subject: "Pagamento della nostra chiamata con Tony Durante",
      body: `${first ? `Ciao ${first},` : "Ciao,"}\n\ngrazie per aver prenotato la nostra chiamata${input.when ? ` (${input.when})` : ""}. Ecco il link per pagarla (${input.amountText}):\n${input.url}\n\nPer qualsiasi domanda, rispondi pure a questa email.`,
    }
  }
  return {
    subject: "Payment for our call with Tony Durante",
    body: `${first ? `Hello ${first},` : "Hello,"}\n\nthank you for booking our call${input.when ? ` (${input.when})` : ""}. Here is the link to pay for it (${input.amountText}):\n${input.url}\n\nIf you have any question, just reply to this email.`,
  }
}
