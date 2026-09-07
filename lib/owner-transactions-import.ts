import { supabaseAdmin } from '@/lib/supabase-admin'
import { isOwnerCategory, TD_ENTITY_ID } from '@/lib/owner-finance'

export interface OwnerImportRow {
  transaction_date: string
  description: string
  counterparty?: string
  amount: number
  currency?: string
  bank_name?: string
  account_type?: string
  transaction_ref?: string
  /** Running account balance after this transaction, when the statement carries it. */
  balance_after?: number | null
  category?: string
  subcategory?: string
  notes?: string
  tax_year: number
}

export interface OwnerImportResult {
  imported: number
  /** Rows whose transaction_ref was already in the books — the identical source, re-uploaded. */
  skipped_same_source: number
  /**
   * Rows that are the SAME MONEY as something already booked under a DIFFERENT
   * transaction_ref — the bank feed's copy, or the same statement in another format.
   */
  skipped_already_booked: number
  /** A few human-readable examples of the same-money skips, for an honest report. */
  duplicate_samples: string[]
}

/**
 * Identity for "is this the same money?", independent of who labelled it.
 *
 * The books have exactly ONE identity today — transaction_ref — and three unrelated
 * generators produce it: the bank-feed sweep writes `feed:<uuid>`, the CSV parsers
 * write a bank reference or a content hash over their own field set, and the PDF/AI
 * path hashes a different field set again. Those namespaces can never collide, so a
 * ref-only dedup cannot see that the feed's copy and the statement's copy of the same
 * payment are the same payment. This key can.
 *
 * Amount is fixed to 2dp so 971 and 971.00 agree; bank is case/space-normalised so
 * "Relay" and "relay financial " do not fork; currency is included so EUR 100 and
 * USD 100 on the same day at the same bank stay distinct.
 */
function contentKey(date: string, amount: number, bank: string | null | undefined, currency: string): string {
  const normBank = (bank ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return `${date}|${Number(amount).toFixed(2)}|${normBank}|${currency.toUpperCase()}`
}

export interface ExistingBooksRow {
  transaction_date: string
  amount: number
  bank_name: string | null
  currency: string | null
  transaction_ref: string | null
}

/**
 * Decide which incoming rows are genuinely new. PURE — no DB — because this is the
 * money-critical decision in the whole import and it must be testable exhaustively.
 *
 * MULTISET counting, not a plain "does a match exist" test. Two separate $971 Stripe
 * payouts on the same day are REAL and must both survive; the running-balance in the
 * content hash is what normally tells them apart, and that is exactly what differs
 * between a feed row and a statement row. So an incoming row is skipped only while an
 * unaccounted-for existing row with the same key remains: N existing + M incoming
 * leaves max(0, M - N) inserted. Erring toward a visible duplicate rather than a
 * silent drop is deliberate — a duplicate can be seen and deleted, a missing
 * transaction cannot.
 */
export function partitionAgainstExisting(
  rows: OwnerImportRow[],
  existing: ExistingBooksRow[],
): {
  toInsert: OwnerImportRow[]
  skippedSameSource: number
  skippedAlreadyBooked: number
  duplicateSamples: string[]
} {
  const existingRefs = new Set(existing.map(e => e.transaction_ref).filter(Boolean) as string[])
  const contentCount = new Map<string, number>()
  for (const e of existing) {
    const k = contentKey(e.transaction_date, e.amount, e.bank_name, e.currency ?? 'USD')
    contentCount.set(k, (contentCount.get(k) ?? 0) + 1)
  }

  const toInsert: OwnerImportRow[] = []
  let skippedSameSource = 0
  let skippedAlreadyBooked = 0
  const duplicateSamples: string[] = []

  for (const r of rows) {
    const key = contentKey(r.transaction_date, r.amount, r.bank_name, r.currency ?? 'USD')
    const available = contentCount.get(key) ?? 0

    if (r.transaction_ref && existingRefs.has(r.transaction_ref)) {
      // Identical source re-uploaded. Consume its existing row too, so that same
      // existing row cannot ALSO absorb a different incoming row below — which
      // would drop a real transaction.
      skippedSameSource++
      if (available > 0) contentCount.set(key, available - 1)
      continue
    }

    if (available > 0) {
      contentCount.set(key, available - 1)
      skippedAlreadyBooked++
      if (duplicateSamples.length < 5) {
        duplicateSamples.push(`${r.transaction_date} ${r.bank_name ?? ''} ${r.amount} ${r.description}`.trim())
      }
      continue
    }

    toInsert.push(r)
  }

  return { toInsert, skippedSameSource, skippedAlreadyBooked, duplicateSamples }
}

/**
 * Existing books rows in the incoming batch's date window.
 *
 * PAGED deliberately: PostgREST silently caps an un-ranged select at 1000 rows with
 * no error, and a duplicate check that silently stops looking after 1000 rows would
 * wave through exactly the duplicates it exists to catch — on the largest imports,
 * which are the ones that matter.
 */
async function fetchExistingInWindow(from: string, to: string) {
  const PAGE = 1000
  const out: { transaction_date: string; amount: number; bank_name: string | null; currency: string; transaction_ref: string | null }[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('td_books_transactions')
      .select('transaction_date, amount, bank_name, currency, transaction_ref')
      .eq('entity_id', TD_ENTITY_ID)
      .gte('transaction_date', from)
      .lte('transaction_date', to)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`duplicate pre-check failed: ${error.message}`)
    const page = data ?? []
    out.push(...(page as typeof out))
    if (page.length < PAGE) break
  }
  return out
}

/**
 * Validate + upsert a batch of rows into td_books_transactions. Shared by the
 * JSON import route and the statement-upload route so the currency/category
 * validation and the insert-once upsert semantics live in exactly one place.
 * Throws on the first validation problem (row index in the message) — callers
 * catch and turn it into their own response shape.
 */
export async function insertOwnerTransactionRows(rows: OwnerImportRow[]): Promise<OwnerImportResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows must be a non-empty array')
  }

  // Currency must be a 3-letter ISO code, normalized UPPERCASE — a CSV "eur" would
  // otherwise create a separate 'eur' P&L block beside 'EUR', and a non-ISO string
  // crashes the currency formatter client-side.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.currency !== undefined && !/^[A-Za-z]{3}$/.test(r.currency)) {
      throw new Error(`Row ${i + 1}: currency "${r.currency}" is not a 3-letter code (e.g. USD, EUR)`)
    }
    if (r.category !== undefined && !isOwnerCategory(r.category)) {
      throw new Error(`Row ${i + 1}: unknown category "${r.category}"`)
    }
  }

  // ── Same-money pre-check ────────────────────────────────────────────────
  // See contentKey() for why transaction_ref alone cannot catch this. Multiset
  // counting, NOT a plain "does a match exist" test: two genuinely separate
  // $971 Stripe payouts on the same day are REAL and must both survive. We skip
  // an incoming row only while an unaccounted-for existing row with the same key
  // remains, so N existing + M incoming leaves max(0, M - N) inserted. Dropping a
  // real transaction would be worse than a visible duplicate — a duplicate can be
  // seen and deleted, a silently missing one cannot.
  const dates = rows.map(r => r.transaction_date).sort()
  const existing = await fetchExistingInWindow(dates[0], dates[dates.length - 1])
  const { toInsert, skippedSameSource, skippedAlreadyBooked, duplicateSamples } =
    partitionAgainstExisting(rows, existing)

  if (toInsert.length === 0) {
    return {
      imported: 0,
      skipped_same_source: skippedSameSource,
      skipped_already_booked: skippedAlreadyBooked,
      duplicate_samples: duplicateSamples,
    }
  }

  const records = toInsert.map(r => ({
    entity_id: TD_ENTITY_ID,
    tax_year: r.tax_year,
    transaction_date: r.transaction_date,
    description: r.description,
    counterparty: r.counterparty ?? null,
    amount: r.amount,
    currency: (r.currency ?? 'USD').toUpperCase(),
    bank_name: r.bank_name ?? null,
    account_type: r.account_type ?? null,
    transaction_ref: r.transaction_ref ?? null,
    // Carried through so the Cash Position card can be built from the owner's own
    // statements. The parsers always produced this; the import path silently
    // dropped it, so getCashPosition (which requires balance_after NOT NULL) could
    // only ever see bank-feed rows no matter how many statements were loaded.
    balance_after: r.balance_after ?? null,
    category: r.category ?? 'uncategorized',
    subcategory: r.subcategory ?? null,
    notes: r.notes ?? null,
    is_related_party: false,
  }))

  const { data, error } = await supabaseAdmin
    .from('td_books_transactions')
    .upsert(records, {
      onConflict: 'entity_id,transaction_ref',
      ignoreDuplicates: true,
    })
    .select('id')

  if (error) throw new Error(error.message)
  return {
    imported: data?.length ?? 0,
    skipped_same_source: skippedSameSource,
    skipped_already_booked: skippedAlreadyBooked,
    duplicate_samples: duplicateSamples,
  }
}
