/**
 * TD BOOKS — statement backfill (Phase 2).
 *
 * Ingests a bank statement FILE (CSV/PDF/zip — parsed by the same battle-tested pipeline
 * the client tax system uses, INCLUDING its learned-format mapping store) into the
 * owner's books. Feeds only reach back so far; statements give the books FULL-YEAR
 * history and make them tie-out-able against real balances.
 *
 * THE DOUBLE-COUNT SPEC (council blockers folded in, 2026-07-29):
 * - Row identity is CONTENT-scoped: `stmt:` + hash(bank|date|amount|currency|parser-ref).
 *   The parser's own ref alone is NOT unique across files (Wise uses the client's
 *   free-text payment reference — a recurring "Dividend" transfer would collide month
 *   after month and silently vanish under the books' ref-only identity).
 * - Coverage runs PER BANK GROUP (a zip can hold several banks' statements) against a
 *   multiset (counted, not set — twin same-day same-amount rows consume one match each)
 *   built from BOTH sources:
 *     (a) existing BOOKS rows for the bank/period — their amounts are SIGNED, which is
 *         what makes swept feeds safe: the sweep overwrites status to 'owner_ledger'
 *         and DESTROYS the 'outgoing' direction marker, so feed status cannot be
 *         trusted for sign on swept rows; their books copy can. Books rows also cover
 *         prior statement imports in a different format (CSV now, PDF earlier).
 *     (b) feed rows whose status still carries direction reliably; rows with
 *         direction-lost statuses (ignored/duplicate/owner_ledger) contribute BOTH
 *         signs — erring toward a visible skip, never a silent double-book.
 * - A bank with NO live feed (Wise) is legitimate but is SAID OUT LOUD in the report.
 * - An AI extraction that FAILED its own opening+Σ=closing reconciliation is REFUSED —
 *   the guard exists precisely so unreconciled numbers never reach books.
 * - Deposits matching a paid-invoice amount (window padded ±14 days — wires settle
 *   across month boundaries) get flagged notes. Nothing is auto-booked either way.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { parseBankStatement, type ParsedTransaction } from "@/lib/bank-statement-parser"
import { stableRowRef } from "@/lib/bank-csv-parsers"
import { makeSupabaseMappingStore } from "@/lib/bank-format-mappings"
import { TD_ENTITY_ID } from "@/lib/owner-finance"
import { BANK_LABELS } from "@/lib/finance/owner-ledger-projection"

export interface StatementBooksRecord {
  entity_id: string
  tax_year: number
  transaction_date: string
  description: string
  counterparty: string | null
  amount: number
  currency: string
  balance_after: number | null
  bank_name: string
  account_type: string | null
  transaction_ref: string
  category: "uncategorized"
  subcategory: null
  is_related_party: false
  notes: string | null
}

export interface FeedRowKeyFields {
  transaction_date: string
  amount: number | string
  currency: string | null
  status: string | null
}

export interface BooksRowKeyFields {
  transaction_date: string
  amount: number | string
  currency: string | null
}

export interface IngestReport {
  file: string
  banks: string[]
  parsed: number
  imported: number
  skipped_already_imported: number
  /** Already captured elsewhere: bank feed OR a previous import in another format. */
  skipped_feed_covered: number
  flagged_possible_client_payment: number
  /** Banks in the file that have NO live feed — every row was treated as new. */
  banks_without_feed: string[]
  parse_errors: string[]
  quarantined: boolean
}

/** Feed statuses whose sign-by-status is still trustworthy. The sweep and manual
 * re-marks overwrite status and lose 'outgoing' — those go the both-signs route. */
const DIRECTION_RELIABLE_STATUSES = new Set([
  "unmatched", "matched", "needs_review", "outgoing", "activation_crashed",
])

/** Banks with statements but NO feed source — still folded so "Wise (TransferWise)"
 * and "WISE" group as one bank in the books and the tie-out. */
const FEEDLESS_BANK_LABELS = ["Wise"]

/** Normalize a bank label from either world (parser labels, feed sources, AI free text)
 * to ONE label per bank. Whole-token-SEQUENCE containment: "JPMorgan Chase"→"Chase",
 * "Banking Circle S.A."→"Banking Circle", "BANKING CIRCLE"→"Banking Circle" — an
 * unmatched AI label silently disables the whole coverage check and splits the
 * tie-out, so folding must survive casing, suffixes and multi-word names. */
export function canonicalBankLabel(raw: string | null | undefined): string {
  const s = (raw ?? "").trim()
  if (!s) return "Other"
  const bySource = BANK_LABELS[s.toLowerCase()]
  if (bySource) return bySource
  const norm = (v: string) => v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ")
  const ns = ` ${norm(s)} `
  const candidates = Array.from(new Set(Object.values(BANK_LABELS))).concat(FEEDLESS_BANK_LABELS)
  for (const label of candidates) {
    if (label === "Other") continue
    if (ns.includes(` ${norm(label)} `)) return label
  }
  return s
}

/** Map parsed statement rows to books records — PURE, unit-tested. */
export function mapParsedToBooksRecords(
  rows: ParsedTransaction[],
  fallbackBank: string
): StatementBooksRecord[] {
  return rows
    .filter(r => r.transaction_ref && r.transaction_date && Number.isFinite(Number(r.amount)))
    .map(r => {
      const bank = canonicalBankLabel(r.bank_name || fallbackBank)
      const currency = /^[A-Za-z]{3}$/.test(r.currency ?? "") ? r.currency.toUpperCase() : "USD"
      const amount = Number(r.amount)
      return {
        entity_id: TD_ENTITY_ID,
        tax_year: Number(r.transaction_date.slice(0, 4)),
        transaction_date: r.transaction_date,
        description: r.description || r.counterparty || "(no description)",
        counterparty: r.counterparty || null,
        amount,
        currency,
        balance_after: r.balance_after !== null && r.balance_after !== undefined ? Number(r.balance_after) : null,
        bank_name: bank,
        account_type: r.account_type || null,
        // Content-scoped identity: same file re-uploaded → same refs (idempotent);
        // a recurring free-text reference in ANOTHER month → different date → new ref.
        transaction_ref: `stmt:${stableRowRef([bank, r.transaction_date, amount.toFixed(2), currency, r.transaction_ref])}`,
        category: "uncategorized" as const,
        subcategory: null,
        is_related_party: false as const,
        notes: null,
      }
    })
}

export function recordKey(rec: Pick<StatementBooksRecord, "transaction_date" | "amount" | "currency">): string {
  return `${rec.transaction_date}|${Number(rec.amount).toFixed(2)}|${rec.currency}`
}

/** Coverage keys contributed by a FEED row. Reliable statuses give one signed key;
 * direction-lost statuses give both signs (skip-leaning, never double-book-leaning).
 *
 * SWEPT ('owner_ledger') and 'duplicate' rows contribute NOTHING: a swept row's books
 * copy already provides its (correctly signed) key, and a duplicate's original row
 * provides its key — counting them here made ONE real transaction cover TWO statement
 * rows, wrongly absorbing a genuine second identical charge (caught in live re-test). */
export function feedCoverageKeys(row: FeedRowKeyFields): string[] {
  const abs = Math.abs(Number(row.amount))
  const currency = (row.currency ?? "USD").toUpperCase()
  const status = row.status ?? ""
  if (status === "owner_ledger" || status === "duplicate") return []
  if (DIRECTION_RELIABLE_STATUSES.has(status)) {
    const signed = status === "outgoing" ? -abs : abs
    return [`${row.transaction_date}|${signed.toFixed(2)}|${currency}`]
  }
  return [
    `${row.transaction_date}|${abs.toFixed(2)}|${currency}`,
    `${row.transaction_date}|${(-abs).toFixed(2)}|${currency}`,
  ]
}

export function booksCoverageKey(row: BooksRowKeyFields): string {
  return `${row.transaction_date}|${Number(row.amount).toFixed(2)}|${(row.currency ?? "USD").toUpperCase()}`
}

/**
 * Split records into covered (skip) vs fresh — MULTISET-counted, PURE, unit-tested.
 * A single captured row absorbs exactly ONE statement twin; the second real same-day
 * same-amount transaction still imports.
 */
export function partitionByCoverage(
  records: StatementBooksRecord[],
  coverageKeys: string[]
): { fresh: StatementBooksRecord[]; covered: StatementBooksRecord[] } {
  const counts = new Map<string, number>()
  for (const k of coverageKeys) counts.set(k, (counts.get(k) ?? 0) + 1)
  const fresh: StatementBooksRecord[] = []
  const covered: StatementBooksRecord[] = []
  for (const rec of records) {
    const k = recordKey(rec)
    const left = counts.get(k) ?? 0
    if (left > 0) {
      counts.set(k, left - 1)
      covered.push(rec)
    } else {
      fresh.push(rec)
    }
  }
  return { fresh, covered }
}

const PAGE = 1000
const INSERT_PAGE = 500

async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    all.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return all
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function ingestOwnerStatement(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<IngestReport> {
  const parsed = await parseBankStatement(fileBuffer, fileName, mimeType, {
    // The learned-format safety layer (S1): unknown layouts QUARANTINE for a one-tap
    // confirmation instead of falling to the generic parser that once double-booked.
    mappingStore: makeSupabaseMappingStore(supabaseAdmin),
  })

  const emptyReport = (errors: string[], quarantined: boolean): IngestReport => ({
    file: fileName, banks: [parsed.bank_name || "unknown"], parsed: parsed.transactions.length,
    imported: 0, skipped_already_imported: 0, skipped_feed_covered: 0,
    flagged_possible_client_payment: 0, banks_without_feed: [],
    parse_errors: errors, quarantined,
  })

  if (parsed.quarantine) {
    return emptyReport([
      "This file's format needs a one-time confirmation before it can be imported. " +
      (parsed.quarantine.ambiguities.join("; ") || ""),
    ], true)
  }
  // An AI extraction that failed its own balance reconciliation must never book.
  if (parsed.reconciliation && parsed.reconciliation.reconciled === false) {
    return emptyReport([
      "The extracted numbers do NOT reconcile against the statement's own balances — refusing to import. " +
      "Try the bank's CSV export for this period instead.",
      ...parsed.errors,
    ], false)
  }

  const records = mapParsedToBooksRecords(parsed.transactions, parsed.bank_name)
  if (records.length === 0) {
    return emptyReport(parsed.errors.length ? parsed.errors : ["No usable transactions found in the file."], false)
  }

  // Coverage runs PER BANK GROUP — a zip can carry several banks' statements, and
  // checking only the first bank's feed would bypass the guard for the rest.
  const byBank = new Map<string, StatementBooksRecord[]>()
  for (const rec of records) {
    const list = byBank.get(rec.bank_name) ?? []
    list.push(rec)
    byBank.set(rec.bank_name, list)
  }

  const fresh: StatementBooksRecord[] = []
  let coveredCount = 0
  const banksWithoutFeed: string[] = []

  for (const [bank, bankRecords] of Array.from(byBank.entries())) {
    const dates = bankRecords.map(r => r.transaction_date).sort()
    const minDate = dates[0]
    const maxDate = dates[dates.length - 1]
    const feedSources = Object.entries(BANK_LABELS)
      .filter(([, label]) => label === bank)
      .map(([source]) => source)

    const coverageKeys: string[] = []

    if (feedSources.length > 0) {
      const feedRows = await fetchAllPages<FeedRowKeyFields & { id: string }>((from, to) => supabaseAdmin
        .from("td_bank_feeds")
        .select("id, transaction_date, amount, currency, status")
        .in("source", feedSources)
        .gte("transaction_date", minDate)
        .lte("transaction_date", maxDate)
        .order("id", { ascending: true })
        .range(from, to), "ingest feed check")
      for (const f of feedRows) coverageKeys.push(...feedCoverageKeys(f))
    } else {
      banksWithoutFeed.push(bank)
    }

    // Books rows for the bank/period: signed amounts — they are what makes SWEPT feeds
    // (direction destroyed by the status overwrite) and prior other-format imports safe.
    const booksRows = await fetchAllPages<BooksRowKeyFields>((from, to) => supabaseAdmin
      .from("td_books_transactions")
      .select("transaction_date, amount, currency")
      .eq("entity_id", TD_ENTITY_ID)
      .eq("bank_name", bank)
      .gte("transaction_date", minDate)
      .lte("transaction_date", maxDate)
      .order("id", { ascending: true })
      .range(from, to), "ingest books check")
    for (const b of booksRows) coverageKeys.push(booksCoverageKey(b))

    const parts = partitionByCoverage(bankRecords, coverageKeys)
    fresh.push(...parts.fresh)
    coveredCount += parts.covered.length
  }

  // Flag surviving DEPOSITS whose amount matches a PAID invoice near the file window
  // (padded — wires settle across month boundaries). Flag only; the human decides.
  let flagged = 0
  const deposits = fresh.filter(r => r.amount > 0)
  if (deposits.length > 0) {
    const dates = fresh.map(r => r.transaction_date).sort()
    const paidNearby = await fetchAllPages<{ amount_paid: number | string; amount_currency: string | null }>((from, to) => supabaseAdmin
      .from("payments")
      .select("amount_paid, amount_currency")
      .gt("amount_paid", 0)
      .not("is_test", "is", true)
      .gte("paid_date", shiftDate(dates[0], -14))
      .lte("paid_date", shiftDate(dates[dates.length - 1], 14))
      .order("id", { ascending: true })
      .range(from, to), "ingest invoice check")
    const paidKeys = new Set(
      paidNearby.map(p => `${Number(p.amount_paid).toFixed(2)}|${(p.amount_currency ?? "USD").toUpperCase()}`)
    )
    for (const dep of deposits) {
      if (paidKeys.has(`${dep.amount.toFixed(2)}|${dep.currency}`)) {
        dep.notes = "⚠ possible client invoice payment — do NOT categorize as income (invoice income is already counted); use the Client payment button if confirmed"
        flagged++
      }
    }
  }

  let imported = 0
  for (let i = 0; i < fresh.length; i += INSERT_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("td_books_transactions")
      .upsert(fresh.slice(i, i + INSERT_PAGE), {
        onConflict: "entity_id,transaction_ref",
        ignoreDuplicates: true,
      })
      .select("id")
    if (error) throw new Error(`ingestOwnerStatement insert: ${error.message}`)
    imported += data?.length ?? 0
  }

  return {
    file: fileName,
    banks: Array.from(byBank.keys()),
    parsed: parsed.transactions.length,
    imported,
    skipped_already_imported: fresh.length - imported,
    skipped_feed_covered: coveredCount,
    flagged_possible_client_payment: flagged,
    banks_without_feed: banksWithoutFeed,
    parse_errors: parsed.errors,
    quarantined: false,
  }
}
