/**
 * `search_bank_feeds` — the read-only tool that lets the payment investigator see OTHER money that came in:
 * "what else did this payer send, and where did we link it?" Without it the model can read mail and the CRM
 * but is blind to the one place that answers "has Simone Fattor paid us before, and for what" — the Bank Feed.
 *
 * Read-only and narrow on purpose:
 *  - TD's own private money (outgoing, the owner's ledger, anything with an owner account) is NEVER returned;
 *  - at most 40 rows, newest first, each with the invoice it was linked to (number, who it belongs to) and
 *    the short result of an earlier investigation if one was kept on it;
 *  - what is searched is text in the sender name / memo, an exact amount, a currency, a date range, a status.
 *
 * Returns a JSON STRING (what every tool in lib/ai-agent returns). Errors come back as `{ error }`, never thrown.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { escapeLikePattern } from "@/lib/finance/payer-suggestions"
import { invoicePartyName } from "@/lib/finance/invoice-party"
import { FEED_STATUSES } from "@/lib/finance/feed-vocabulary"

export const SEARCH_BANK_FEEDS_DEFAULT_LIMIT = 20
export const SEARCH_BANK_FEEDS_MAX_LIMIT = 40
const MAX_WORDS = 5
const MIN_WORD = 2

export interface SearchBankFeedsParams {
  /** Words that must each appear in the sender name or the memo. */
  words: string[]
  amount: number | null
  currency: string | null
  from: string | null
  to: string | null
  status: string | null
  limit: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function parseSearchBankFeedsParams(input: unknown): { ok: true; value: SearchBankFeedsParams } | { ok: false; error: string } {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>

  const text = typeof p.sender === "string" ? p.sender : typeof p.text === "string" ? p.text : ""
  // Only letters, digits and . @ ' - survive: a word goes into a PostgREST filter string, where a comma,
  // bracket, % or _ would change what is asked rather than what is searched.
  const words = Array.from(new Set(text.split(/[\s,;|]+/).map((w) => w.replace(/[^A-Za-z0-9À-ɏ.@'-]/g, "").toLowerCase()).filter((w) => w.length >= MIN_WORD))).slice(0, MAX_WORDS)

  const amountRaw = p.amount
  const amount = amountRaw == null || amountRaw === "" ? null : Number(amountRaw)
  if (amount !== null && !Number.isFinite(amount)) return { ok: false, error: "amount must be a number." }

  const currency = typeof p.currency === "string" && /^[A-Za-z]{3}$/.test(p.currency.trim()) ? p.currency.trim().toUpperCase() : null
  const from = typeof p.from === "string" && DATE_RE.test(p.from.trim()) ? p.from.trim() : null
  const to = typeof p.to === "string" && DATE_RE.test(p.to.trim()) ? p.to.trim() : null
  if (p.from != null && p.from !== "" && !from) return { ok: false, error: "from must be a date like 2026-05-29." }
  if (p.to != null && p.to !== "" && !to) return { ok: false, error: "to must be a date like 2026-05-29." }

  const status = typeof p.status === "string" && p.status.trim() ? p.status.trim() : null
  if (status && !(FEED_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of: ${FEED_STATUSES.join(", ")}.` }
  }

  if (words.length === 0 && amount === null && !from && !to && !status) {
    return { ok: false, error: "Give at least one filter: sender words, an amount, a date range or a status." }
  }

  const limitRaw = Number(p.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), SEARCH_BANK_FEEDS_MAX_LIMIT) : SEARCH_BANK_FEEDS_DEFAULT_LIMIT

  return { ok: true, value: { words, amount, currency, from, to, status, limit } }
}

type Embedded<T> = T | T[] | null | undefined
const first = <T,>(v: Embedded<T>): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined)

interface FeedRow {
  id: string
  source: string | null
  transaction_date: string | null
  amount: number | string | null
  currency: string | null
  sender_name: string | null
  memo: string | null
  status: string | null
  review_metadata: Record<string, unknown> | null
  payments: Embedded<{
    id?: string
    invoice_number: string | null
    description: string | null
    invoice_status: string | null
    notes?: string | null
    accounts: Embedded<{ company_name: string | null }>
    contacts: Embedded<{ full_name: string | null }>
  }>
}

/** One row as the model sees it. Pure, so the shape is tested without a database. */
export function shapeFeedRow(row: FeedRow) {
  const pay = first(row.payments)
  const inv = row.review_metadata && typeof row.review_metadata === "object" ? (row.review_metadata as Record<string, unknown>).investigation : null
  const investigation = inv && typeof inv === "object"
    ? { verdict: (inv as Record<string, unknown>).verdict ?? null, summary: (inv as Record<string, unknown>).summary ?? null, at: (inv as Record<string, unknown>).at ?? null }
    : null
  return {
    feed_id: row.id,
    date: row.transaction_date,
    amount: row.amount == null ? null : Number(row.amount),
    currency: row.currency,
    source: row.source,
    sender: row.sender_name,
    memo: row.memo ? String(row.memo).slice(0, 200) : null,
    status: row.status,
    linked_invoice: pay
      ? {
          payment_id: pay.id ?? null,
          invoice_number: pay.invoice_number,
          belongs_to: invoicePartyName({ accounts: pay.accounts, contacts: pay.contacts }),
          description: pay.description,
          invoice_status: pay.invoice_status,
          // The invoice's internal note — an earlier investigation of a payment lives here.
          note: pay.notes ? String(pay.notes).slice(0, 600) : null,
        }
      : null,
    earlier_investigation: investigation,
  }
}

export async function searchBankFeeds(input: unknown): Promise<string> {
  const parsed = parseSearchBankFeedsParams(input)
  if (parsed.ok === false) return JSON.stringify({ error: parsed.error })
  const p = parsed.value

  try {
    let q = supabaseAdmin
      .from("td_bank_feeds")
      .select("id, source, transaction_date, amount, currency, sender_name, memo, status, review_metadata, payments:matched_payment_id(id, invoice_number, description, invoice_status, notes, accounts:account_id(company_name), contacts:payments_contact_id_fkey(full_name))")
      // TD's own private money is never shown to the investigator.
      .not("status", "in", "(outgoing,owner_ledger)")
      .is("owner_account_number", null)

    for (const w of p.words) {
      const like = `%${escapeLikePattern(w)}%`
      q = q.or(`sender_name.ilike.${like},memo.ilike.${like}`)
    }
    if (p.amount !== null) q = q.eq("amount", p.amount)
    if (p.currency) q = q.eq("currency", p.currency)
    if (p.from) q = q.gte("transaction_date", p.from)
    if (p.to) q = q.lte("transaction_date", p.to)
    if (p.status) q = q.eq("status", p.status)

    const { data, error } = await q.order("transaction_date", { ascending: false }).limit(p.limit)
    if (error) return JSON.stringify({ error: `Could not search the Bank Feed: ${error.message}` })

    const rows = ((data ?? []) as unknown as FeedRow[]).map(shapeFeedRow)
    return JSON.stringify({ total: rows.length, results: rows })
  } catch (err) {
    return JSON.stringify({ error: `Could not search the Bank Feed: ${err instanceof Error ? err.message : String(err)}` })
  }
}
