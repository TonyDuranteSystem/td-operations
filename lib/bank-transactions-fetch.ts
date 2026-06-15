/**
 * Paginated reads for `bank_transactions`.
 *
 * WHY THIS EXISTS: supabase-js (PostgREST) caps a single `select()` at 1000
 * rows by default. Every financials read used to fetch unbounded, so any
 * account with >1000 transactions in a tax year had its P&L, Balance Sheet,
 * verification gates, and categorization computed on only the first 1000 rows
 * — silently wrong totals (found 2026-06-13: Uxio Test LLC had 1,992 rows, the
 * view read 1,000; real clients like Dynamiq carry ~4,800). This helper pages
 * through `.range()` until every row is read.
 *
 * STABLE ORDERING: range-based pagination is only safe when the sort key is
 * unique — otherwise rows sharing the key can be skipped or duplicated across
 * page boundaries. `fetchAllBankTransactionsByYear` always appends `id` as a
 * final tiebreaker so pages never overlap or drop rows.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export const BANK_TX_PAGE_SIZE = 1000

/**
 * Pure pagination driver — calls `fetchPage(from, to)` in fixed-size windows
 * until a short page signals the end. DB-free, so it is unit-testable in
 * isolation. A page shorter than `pageSize` (including empty) ends the loop;
 * an exact multiple of `pageSize` triggers one final empty fetch, which is
 * harmless and correct.
 */
export async function fetchAllPaged<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize: number = BANK_TX_PAGE_SIZE,
): Promise<T[]> {
  if (pageSize < 1) throw new Error("pageSize must be >= 1")
  const all: T[] = []
  for (let from = 0; ; from += pageSize) {
    const batch = await fetchPage(from, from + pageSize - 1)
    all.push(...batch)
    if (batch.length < pageSize) break
  }
  return all
}

/**
 * Read EVERY `bank_transactions` row for an account + tax year, beyond the
 * 1000-row cap. `columns` is the PostgREST select string. `order` is the
 * primary sort (default `id`); `id` is always appended as a unique tiebreaker
 * for safe paging — so callers that need chronological output (e.g. last
 * balance_after wins) pass `{ column: "transaction_date", ascending: true }`
 * and still get deterministic pages.
 */
export async function fetchAllBankTransactionsByYear<T = Record<string, unknown>>(
  accountId: string,
  taxYear: number,
  columns: string,
  order: { column: string; ascending: boolean } = { column: "id", ascending: true },
): Promise<T[]> {
  return fetchAllPaged<T>(async (from, to) => {
    let q = supabaseAdmin
      .from("bank_transactions")
      .select(columns)
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .order(order.column, { ascending: order.ascending })
    if (order.column !== "id") q = q.order("id", { ascending: true })
    const { data, error } = await q.range(from, to)
    if (error) throw new Error(`Failed to load transactions: ${error.message}`)
    return (data ?? []) as T[]
  })
}
