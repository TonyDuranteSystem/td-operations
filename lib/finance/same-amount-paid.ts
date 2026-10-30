/**
 * The reader behind the Match popup's "already-paid invoices of exactly this amount" box. See
 * lib/finance/same-amount-labels.ts for why it exists and for the words it shows.
 *
 * For ONE bank transaction: the invoices already marked PAID whose amount and currency are exactly this payment's,
 * paid within a few days of its date, that no OTHER bank payment is tied to — whoever they belong to. This is the
 * payer-independent complement of lib/finance/payer-invoices.ts, which only offers invoices of a company the payer is
 * already known to be.
 *
 * Why it is safe to show: it only reads, the rows go into the popup's existing "link for the record" selection (no
 * money moves; the server still refuses an invoice another transaction has claimed), and what it lists is a
 * coincidence of amount and date that the box says is not proof.
 *
 * Real numbers (production, read only, 2026-10-30), over the 401 payments matched since January: within 3 days the right
 * invoice was in this list 296 times (74%); when it listed exactly one, that one was right 193 times out of 198.
 * Those were the easy, already-matched cases — the leftovers will do worse.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isPaidInvoice } from "@/lib/finance/invoice-matchability"
import { readClaimedInvoiceIds } from "@/lib/finance/claimed-invoices"
import { daysFromPayment } from "@/lib/finance/feed-investigation"
import { windowAround } from "@/lib/finance/feed-nearby-sweep"
import { INVOICE_COLUMNS, toPayerInvoice, type RawInvoice } from "@/lib/finance/payer-invoices"
import { normalizeDays, shownCap, type SameAmountInvoice, type SameAmountPaidResult } from "@/lib/finance/same-amount-labels"

/** Rows read before the exact checks narrow them; far more than the box ever lists. */
const DB_LIMIT = 200

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === "string" ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

const sameMoney = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 0.005

/**
 * An invoice that can be offered here: genuinely PAID (money received — not a credit note, which is "Paid" too but a
 * negative amount paid OUT), not a test invoice, not refunded, and exactly this payment's amount.
 */
export function isSameAmountCandidate(inv: RawInvoice, amount: number): boolean {
  if (inv.is_test === true) return false
  if (String(inv.status ?? "") === "Refunded") return false
  if (!isPaidInvoice(inv)) return false
  const total = num(inv.total)
  const own = num(inv.amount)
  if (!((total ?? own ?? 0) > 0)) return false
  return sameMoney(total, amount) || sameMoney(own, amount)
}

/**
 * Split what the database returned into what is shown, how many fit, and how many were left out because another bank
 * payment is already tied to them. Closest paid day first (then the newest paid, then by number), capped.
 */
export function partitionSameAmount(
  rows: readonly RawInvoice[],
  amount: number,
  claimed: Set<string>,
  paymentDate: string | null,
  cap: number,
): { invoices: SameAmountInvoice[]; found: number; tied: number } {
  const eligible = rows.filter((r) => isSameAmountCandidate(r, amount))
  const free = eligible.filter((r) => !claimed.has(r.id))
  const tied = eligible.length - free.length
  const ranked: SameAmountInvoice[] = free
    .map((r) => ({ ...toPayerInvoice(r, claimed), days_from_payment: daysFromPayment(paymentDate, r.paid_date) }))
    .sort((a, b) => {
      const da = a.days_from_payment === null ? Number.POSITIVE_INFINITY : Math.abs(a.days_from_payment)
      const db = b.days_from_payment === null ? Number.POSITIVE_INFINITY : Math.abs(b.days_from_payment)
      return da - db || String(b.paid_date ?? "").localeCompare(String(a.paid_date ?? "")) || String(a.invoice_number ?? "").localeCompare(String(b.invoice_number ?? ""))
    })
  return { invoices: ranked.slice(0, cap), found: free.length, tied }
}

export async function loadSameAmountPaid(params: { feedId: string; days?: unknown; isOwner: boolean }): Promise<SameAmountPaidResult> {
  const days = normalizeDays(params.days)
  const { data: feed, error: feedErr } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, amount, currency, transaction_date, status, owner_account_number")
    .eq("id", params.feedId)
    .maybeSingle()
  if (feedErr) return { ok: false, error: `Could not read the transaction: ${feedErr.message}` }
  if (!feed) return { ok: false, error: "Transaction not found." }

  // TD's own money is the owner's business, not the staff's — the same rule the rest of the Bank Feed applies.
  const privateToOwner = feed.status === "outgoing" || feed.status === "owner_ledger" || !!feed.owner_account_number
  if (privateToOwner && !params.isOwner) return { ok: false, error: "Transaction not found." }

  const amount = num(feed.amount as number | string | null)
  const paymentDate = feed.transaction_date ? String(feed.transaction_date).slice(0, 10) : null
  const window = windowAround(paymentDate, days, days)
  // Invoices exist in dollars and euros only: a payment in any other currency, without an amount or a date, has nothing to look for.
  if (amount === null || !(amount > 0) || (feed.currency !== "USD" && feed.currency !== "EUR") || !window) {
    return { ok: true, searched: false, days, invoices: [], found: 0, already_tied: 0 }
  }

  const { data, error } = await supabaseAdmin
    .from("payments")
    .select(INVOICE_COLUMNS)
    .eq("amount_currency", feed.currency)
    .or(`total.eq.${amount},amount.eq.${amount}`)
    .gte("paid_date", window.from)
    .lte("paid_date", window.to)
    .not("is_test", "is", true)
    .order("paid_date", { ascending: false })
    .limit(DB_LIMIT)
  if (error) return { ok: false, error: "Could not read the paid invoices." }

  const rows = (data ?? []) as unknown as RawInvoice[]
  const candidates = rows.filter((r) => isSameAmountCandidate(r, amount))
  // Only a paid invoice can be "taken" by another transaction — and every candidate here is paid.
  const claimed = await readClaimedInvoiceIds(candidates.map((r) => r.id), feed.id)
  if (claimed === null) return { ok: false, error: "Could not check which invoices are already linked to another payment." }

  const { invoices, found, tied } = partitionSameAmount(rows, amount, claimed, paymentDate, shownCap(days))
  return { ok: true, searched: true, days, invoices, found, already_tied: tied }
}
