/**
 * Owner-ledger projection — copies TD's OWN bank activity (everything that is NOT a
 * client invoice payment) into My Finances so Antonio can categorize it and do the
 * company's accounting. Finance stays what it is meant to be: client invoice payments only.
 *
 * THE SAFETY RULE (non-negotiable, and the reason this file exists as one writer):
 * `bank_transactions` is MULTI-TENANT — it holds every client's tax data alongside the
 * owner's books, separated only by `account_id`. This writer therefore HARD-PINS
 * `account_id` to the owner constant and NEVER derives it from the feed. A projected row
 * can never land in a client's tax return. `buildOwnerLedgerRow` is pure so this is
 * unit-testable, and `projectFeedsToOwnerLedger` asserts the invariant again before writing.
 *
 * Other invariants (each one a Council finding, 2026-07-27):
 *  - SIGNED amount. Feeds store an absolute amount with direction in `status` ('outgoing'),
 *    but the owner P&L branches on sign — copying the raw magnitude books an expense as income.
 *  - NON-BLANK deterministic ref (`feed:<id>`). The column is NOT NULL + non-blank CHECK and
 *    supabase-js RETURNS errors rather than throwing, so a blank ref silently drops the row.
 *  - Dedup targets the REAL unique key (account_id, transaction_ref, transaction_date, amount).
 *  - `tax_year` from the transaction date; per-row `currency` preserved (no FX guessing here).
 *  - Category always starts 'uncategorized' — nothing is auto-booked as income or expense.
 *    Antonio categorizes; the books are never silently invented.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { classifyFeedType, type FeedSignalSource } from "@/lib/finance/feed-signals"
import { updateFeeds } from "@/lib/finance/feed-write"

/** The owner's books. Every projected row carries THIS and only this. */
export const OWNER_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001"

/** Feed row fields the projection reads. */
export interface ProjectableFeed extends FeedSignalSource {
  id: string
  transaction_date: string
  amount: number | string
  currency?: string | null
  status?: string | null
  external_id?: string | null
}

/** A row as My Finances stores it. */
export interface OwnerLedgerRow {
  account_id: string
  tax_year: number
  transaction_date: string
  description: string
  counterparty: string | null
  amount: number
  currency: string
  bank_name: string
  transaction_ref: string
  category: string
  notes: string | null
}

/** Feed source → the bank label My Finances groups cash by. */
const BANK_LABELS: Record<string, string> = {
  relay: "Relay",
  mercury: "Mercury",
  mercury_api: "Mercury",
  airwallex_api: "Airwallex",
  airwallex_email: "Airwallex",
  banking_circle: "Banking Circle",
  chase: "Chase",
  stripe: "Stripe",
  qb_deposit: "Other",
  manual: "Other",
}

/**
 * Does this feed belong in the owner's books rather than the client-invoice feed?
 *
 * YES for: money TD spent (`outgoing`), Stripe payouts, and bank rewards.
 * NO for: anything that is (or might still be) a client paying an invoice — those stay in
 * Finance. Uncertainty always resolves to "leave it in Finance": failing to project is a
 * visible gap in the owner's books, while wrongly projecting hides a client payment from
 * reconciliation and the client's service never activates.
 */
export function isOwnerLedgerFeed(feed: ProjectableFeed): boolean {
  if (feed.status === "outgoing") return true
  const { type } = classifyFeedType(feed)
  return type === "stripe_payout" || type === "bank_reward"
}

/**
 * Pure: feed row → owner-ledger row. Returns null if the feed cannot be projected safely
 * (unparseable date or amount) — a dropped row is better than a corrupt one.
 */
export function buildOwnerLedgerRow(feed: ProjectableFeed): OwnerLedgerRow | null {
  const rawAmount = typeof feed.amount === "string" ? Number(feed.amount) : feed.amount
  if (!Number.isFinite(rawAmount)) return null

  const date = String(feed.transaction_date ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  // Feeds carry an absolute amount; direction lives in `status`. The owner ledger is signed.
  const magnitude = Math.abs(rawAmount)
  const signed = feed.status === "outgoing" ? -magnitude : magnitude

  const description = (feed.memo || feed.sender_name || "Bank transaction").trim()

  return {
    account_id: OWNER_ACCOUNT_ID, // HARD-PINNED — never derived from the feed.
    tax_year: Number(date.slice(0, 4)),
    transaction_date: date,
    description,
    counterparty: feed.sender_name?.trim() || null,
    amount: Math.round(signed * 100) / 100,
    currency: (feed.currency || "USD").toUpperCase(),
    bank_name: BANK_LABELS[feed.source ?? ""] ?? "Other",
    transaction_ref: `feed:${feed.id}`, // deterministic + never blank
    category: "uncategorized", // Antonio categorizes; nothing is auto-booked
    notes: null,
  }
}

/**
 * The scheduled sweep: find bank activity that is TD's own money, copy it into My Finances,
 * and take it out of the Bank Feed. Runs BEFORE the invoice matcher each cycle, so a Stripe
 * payout is never scored against a client invoice in the first place.
 *
 * Scope: everything except `matched` (its status carries the invoice link — those feeds are
 * still COPIED to the owner's books but never re-labelled) and rows already `owner_ledger`.
 * The copy is an upsert on a deterministic ref, so re-running is harmless.
 */
export async function sweepFeedsToOwnerLedger(): Promise<ProjectionResult> {
  const { data, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id")
    .not("status", "in", '("owner_ledger")')
    .limit(2000)

  if (error) {
    return { ok: false, considered: 0, projected: 0, skipped: 0, error: error.message }
  }
  return projectFeedsToOwnerLedger((data ?? []) as ProjectableFeed[], { markFeeds: true })
}

export interface ProjectionResult {
  ok: boolean
  considered: number
  projected: number
  skipped: number
  /** Feeds marked `owner_ledger` so the Bank Feed stops showing them to staff. */
  marked?: number
  error?: string
}

/**
 * Project every owner-ledger feed into My Finances. Idempotent: upserts on the table's real
 * unique key, so a re-run refreshes rather than duplicates. Never writes a client account.
 */
export async function projectFeedsToOwnerLedger(
  feeds: ProjectableFeed[],
  opts: { markFeeds?: boolean } = {},
): Promise<ProjectionResult> {
  const rows: OwnerLedgerRow[] = []
  const markable: string[] = []
  for (const feed of feeds) {
    if (!isOwnerLedgerFeed(feed)) continue
    const row = buildOwnerLedgerRow(feed)
    if (!row) continue
    rows.push(row)
    // Never re-label a settled feed: `matched` carries the link to the invoice it paid, and
    // the 1-invoice-many-feeds guard keys on it. Copy it to the owner's books, but leave the
    // feed's status alone.
    if (feed.status !== "matched") markable.push(feed.id)
  }

  // Belt-and-braces: the invariant is asserted again at the boundary, not just assumed.
  const stray = rows.find((r) => r.account_id !== OWNER_ACCOUNT_ID)
  if (stray) {
    return {
      ok: false,
      considered: feeds.length,
      projected: 0,
      skipped: feeds.length,
      error: "refusing to write: a row was not scoped to the owner account",
    }
  }

  if (rows.length === 0) {
    return { ok: true, considered: feeds.length, projected: 0, skipped: feeds.length }
  }

  const { error } = await supabaseAdmin
    .from("bank_transactions")
    .upsert(rows, { onConflict: "account_id,transaction_ref,transaction_date,amount" })

  if (error) {
    return { ok: false, considered: feeds.length, projected: 0, skipped: feeds.length, error: error.message }
  }

  // COPY FIRST, MARK AFTER — and only if the copy actually landed. Marking a feed
  // `owner_ledger` removes it from the Bank Feed, so doing it before the copy succeeded
  // would take the transaction off BOTH screens. This ordering is the same discipline as
  // safeSend: never record the after-state until the real work has happened.
  let marked = 0
  if (opts.markFeeds && markable.length > 0) {
    const res = await updateFeeds(markable, { status: "owner_ledger" }, "owner-ledger-projection")
    if (!res.ok) {
      return {
        ok: false,
        considered: feeds.length,
        projected: rows.length,
        skipped: feeds.length - rows.length,
        marked: 0,
        error: `copied to My Finances, but marking the feeds failed: ${res.error}`,
      }
    }
    marked = markable.length
  }

  return {
    ok: true,
    considered: feeds.length,
    projected: rows.length,
    skipped: feeds.length - rows.length,
    marked,
  }
}
