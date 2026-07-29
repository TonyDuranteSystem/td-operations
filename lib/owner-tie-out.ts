/**
 * TD BOOKS — per-bank tie-out (Phase 2 gate: "books tie to the statements").
 *
 * For each (bank, currency, year): statement closing balance should equal
 *   opening + owner books movement + client-money movement the feed captured.
 *
 * Two movement sources, PROVABLY disjoint:
 * - td_books_transactions — the owner's side (the projection only ever copies feeds that
 *   fail the client-payment test, so no client money is in here);
 * - td_bank_feeds — everything else the bank saw, chiefly client invoice payments.
 *   Feed rows already swept INTO books (their id appears as a `feed:` ref) are excluded
 *   here, or swept rows would count twice. Feed `duplicate` rows are excluded (they are
 *   the SAME money as another row); `ignored` rows still count — ignoring is a matching
 *   decision, the money moved regardless.
 *
 * A gap between expected and stated closing = movement the system never captured
 * (typically history before the feed window) → the statement backfill fills it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { TD_ENTITY_ID } from "@/lib/owner-finance"
import { BANK_LABELS } from "@/lib/finance/owner-ledger-projection"

export interface TieOutRow {
  bank_key: string
  currency: string
  opening_balance: number | null
  closing_balance: number | null
  books_movement: number
  feed_movement: number
  books_rows: number
  feed_rows: number
  /** opening + both movements; null when no opening was entered. */
  expected_closing: number | null
  /** stated closing − expected; null unless both balances entered. */
  difference: number | null
  notes: string | null
}

interface BooksRowSlim {
  bank_name: string | null
  currency: string | null
  amount: number | string
  transaction_ref: string | null
}
interface FeedRowSlim {
  id: string
  source: string | null
  currency: string | null
  amount: number | string
  status: string | null
}
interface BalanceRowSlim {
  bank_key: string
  currency: string
  opening_balance: number | string | null
  closing_balance: number | string | null
  notes: string | null
}

/** PURE tie-out math — unit-tested. */
export function computeTieOutRows(
  booksRows: BooksRowSlim[],
  feedRows: FeedRowSlim[],
  balances: BalanceRowSlim[]
): TieOutRow[] {
  const sweptFeedIds = new Set(
    booksRows
      .map(r => r.transaction_ref)
      .filter((ref): ref is string => !!ref && ref.startsWith("feed:"))
      .map(ref => ref.slice("feed:".length))
  )

  const buckets = new Map<string, { books: number; booksN: number; feed: number; feedN: number }>()
  const bucketFor = (bank: string, currency: string) => {
    const key = `${bank}|${currency}`
    let b = buckets.get(key)
    if (!b) { b = { books: 0, booksN: 0, feed: 0, feedN: 0 }; buckets.set(key, b) }
    return b
  }

  for (const r of booksRows) {
    const b = bucketFor(r.bank_name || "Other", (r.currency || "USD").toUpperCase())
    b.books += Number(r.amount)
    b.booksN += 1
  }

  for (const f of feedRows) {
    if (f.status === "duplicate") continue
    if (sweptFeedIds.has(f.id)) continue
    const label = BANK_LABELS[f.source ?? ""] ?? "Other"
    const abs = Math.abs(Number(f.amount))
    // ACCEPTED LIMIT: a row re-marked 'ignored' AFTER being 'outgoing' lost its
    // direction (status is mutable, no direction column exists) and counts here as an
    // inflow — off by 2×amount in feed_movement. Rare (ignore was historically used on
    // deposits), visible in the tie-out difference, and unfixable without persisting
    // direction; flagged by the Phase 2 review and deliberately not guessed at.
    const signed = f.status === "outgoing" ? -abs : abs
    const b = bucketFor(label, (f.currency || "USD").toUpperCase())
    b.feed += signed
    b.feedN += 1
  }

  const balanceMap = new Map(balances.map(b => [`${b.bank_key}|${b.currency.toUpperCase()}`, b]))
  const allKeys = new Set(Array.from(buckets.keys()).concat(Array.from(balanceMap.keys())))

  const rows: TieOutRow[] = []
  for (const key of Array.from(allKeys)) {
    const [bank_key, currency] = key.split("|")
    const bucket = buckets.get(key) ?? { books: 0, booksN: 0, feed: 0, feedN: 0 }
    const bal = balanceMap.get(key)
    const opening = bal?.opening_balance !== null && bal?.opening_balance !== undefined ? Number(bal.opening_balance) : null
    const closing = bal?.closing_balance !== null && bal?.closing_balance !== undefined ? Number(bal.closing_balance) : null
    const expected = opening !== null ? opening + bucket.books + bucket.feed : null
    rows.push({
      bank_key,
      currency,
      opening_balance: opening,
      closing_balance: closing,
      books_movement: Math.round(bucket.books * 100) / 100,
      feed_movement: Math.round(bucket.feed * 100) / 100,
      books_rows: bucket.booksN,
      feed_rows: bucket.feedN,
      expected_closing: expected !== null ? Math.round(expected * 100) / 100 : null,
      difference: expected !== null && closing !== null ? Math.round((closing - expected) * 100) / 100 : null,
      notes: bal?.notes ?? null,
    })
  }

  return rows.sort((a, z) => a.bank_key.localeCompare(z.bank_key) || a.currency.localeCompare(z.currency))
}

const PAGE = 1000

async function fetchAllPages<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    all.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return all
}

export async function computeBooksTieOut(year: number): Promise<TieOutRow[]> {
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`

  const [booksRows, feedRows, balances] = await Promise.all([
    fetchAllPages<BooksRowSlim>((from, to) => supabaseAdmin
      .from("td_books_transactions")
      .select("bank_name, currency, amount, transaction_ref")
      .eq("entity_id", TD_ENTITY_ID)
      .eq("tax_year", year)
      .order("id", { ascending: true })
      .range(from, to), "tie-out books"),
    fetchAllPages<FeedRowSlim>((from, to) => supabaseAdmin
      .from("td_bank_feeds")
      .select("id, source, currency, amount, status")
      .gte("transaction_date", yearStart)
      .lte("transaction_date", yearEnd)
      .order("id", { ascending: true })
      .range(from, to), "tie-out feeds"),
    fetchAllPages<BalanceRowSlim>((from, to) => supabaseAdmin
      .from("td_books_bank_balances")
      .select("bank_key, currency, opening_balance, closing_balance, notes")
      .eq("entity_id", TD_ENTITY_ID)
      .eq("tax_year", year)
      .order("id", { ascending: true })
      .range(from, to), "tie-out balances"),
  ])

  return computeTieOutRows(booksRows, feedRows, balances)
}
