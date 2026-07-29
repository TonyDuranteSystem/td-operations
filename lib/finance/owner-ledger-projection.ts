/**
 * Owner-ledger projection — copies TD's OWN bank activity (everything that is NOT a
 * client invoice payment) into My Finances so Antonio can categorize it and do the
 * company's accounting. Finance stays what it is meant to be: client invoice payments only.
 *
 * Since Phase 1a (2026-07-29) the books live in their OWN table, `td_books_transactions` —
 * no longer a slice of the multi-tenant client tax table. The writer still HARD-PINS the
 * entity to the TD constant and NEVER derives it from the feed, and the boundary re-assert
 * before writing stays: cheap, and it keeps the invariant explicit for the next writer.
 *
 * Invariants (Council findings, 2026-07-27 + Phase 1a review):
 *  - SIGNED amount. Feeds store an absolute amount with direction in `status` ('outgoing'),
 *    but the owner P&L branches on sign — copying the raw magnitude books an expense as income.
 *  - NON-BLANK deterministic ref (`feed:<id>`). The column is NOT NULL + non-blank CHECK and
 *    supabase-js RETURNS errors rather than throwing, so a blank ref silently drops the row.
 *  - INSERT-ONCE. Identity is (entity, transaction_ref) alone; date/amount are payload. A
 *    books row is stateful the moment Antonio categorizes it — the writer must never rewrite
 *    an existing row (ignoreDuplicates, not update-on-conflict).
 *  - `tax_year` from the transaction date; per-row `currency` preserved (no FX guessing here).
 *  - Category always starts 'uncategorized' — nothing is auto-booked as income or expense.
 *    Antonio categorizes; the books are never silently invented.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  extractFeedEmails,
  extractInvoiceReference,
  extractStripePaymentIntent,
  type FeedSignalSource,
} from "@/lib/finance/feed-signals"
import { isMatchableInvoice } from "@/lib/finance/invoice-matchability"
import { updateFeeds } from "@/lib/finance/feed-write"

import { TD_ENTITY_ID } from "@/lib/owner-finance"

/** The owner's books entity. ONE definition (lib/owner-finance) — two independent copies
 *  of this constant were a named migration hazard. Re-exported under the old name for
 *  existing imports; same value. */
export const OWNER_ACCOUNT_ID = TD_ENTITY_ID

/** Feed row fields the projection reads. */
export interface ProjectableFeed extends FeedSignalSource {
  id: string
  transaction_date: string
  amount: number | string
  currency?: string | null
  status?: string | null
  external_id?: string | null
  matched_payment_id?: string | null
}

/** A row as My Finances stores it (td_books_transactions — the books' OWN table since
 *  Phase 1a, no longer a slice of the multi-tenant client tax table). */
export interface OwnerLedgerRow {
  entity_id: string
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

/** Feed source → the bank label My Finances groups cash by. Exported: the statement
 * backfill (Phase 2) must label banks IDENTICALLY or the tie-out splits one bank in two. */
export const BANK_LABELS: Record<string, string> = {
  relay: "Relay",
  mercury: "Mercury",
  mercury_api: "Mercury",
  airwallex_api: "Airwallex",
  airwallex_email: "Airwallex",
  banking_circle: "Banking Circle",
  chase: "Chase",
  stripe: "Stripe",
  revolut: "Revolut",
  qb_deposit: "Other",
  manual: "Other",
}

/** An open invoice, reduced to what the "could this be paying an invoice?" test needs. */
export interface OpenInvoiceRef {
  amount: number
  currency?: string | null
}

/**
 * Is this deposit POSITIVELY a client paying an invoice?
 *
 * This is the whole decision, and it is deliberately the only positive test in the system
 * (Antonio, 2026-07-27): *"a system that will recognize the payments that are NOT from
 * clients for invoices… if something is wrong or the system doesn't know, put it in My
 * Finances, with a button 'this is for client' to put it back in Finance."*
 *
 * So Finance keeps a deposit only when something concrete says "a client is paying an
 * invoice". Everything else — including anything unrecognised — goes to My Finances, where
 * Antonio sees it in his own section and can send it back with one click. That is what makes
 * the default safe: the fallback is not a hidden bucket, it is HIS screen, and it is reversible.
 *
 * Note this inverts the previous design, which tried to prove a row WAS a payout (by its
 * wording) and left everything else in Finance. Proving the positive — "this is a client
 * payment" — is the reliable direction, because a client payment carries evidence (an invoice
 * number, a card payment reference, a payer email, or an amount matching something owed)
 * while "not a client payment" is an absence, and absence can never be proven from wording.
 */
export function isClientInvoicePayment(feed: ProjectableFeed, openInvoices: OpenInvoiceRef[] = []): boolean {
  // Money LEAVING the account is never a client paying an invoice.
  if (feed.status === "outgoing") return false

  // Already reconciled against an invoice — never second-guess the matcher. Both the status
  // and the link are checked: either alone is enough to mean "this money is already a client's
  // settled payment", and a row that lost one of the two must still be protected.
  if (feed.status === "matched" || feed.matched_payment_id) return true

  // A Stripe card charge carries its own payment reference — the certain link.
  if (extractStripePaymentIntent(feed)) return true

  // An invoice number on the payment (the reference clients are told to quote).
  if (extractInvoiceReference(feed)) return true
  const text = `${feed.sender_name ?? ""} ${feed.memo ?? ""} ${feed.sender_reference ?? ""}`
  if (/\bINV-?\d{4,}\b/i.test(text)) return true

  // A payer email — resolves to a contact, and only client payments carry one.
  if (extractFeedEmails(feed).length > 0) return true

  // The amount matches something a client currently owes. Deliberately the WIDEST tolerance
  // in the system (20% or $50, whichever is larger): this is a VETO protecting a client's
  // money, and being over-cautious costs only a row Antonio moves himself, while being
  // under-cautious costs a client's payment. Currency must agree — a €1,000 deposit is not
  // evidence for a $1,000 invoice.
  const amount = Math.abs(typeof feed.amount === "string" ? Number(feed.amount) : feed.amount)
  if (Number.isFinite(amount)) {
    const feedCurrency = (feed.currency || "USD").toUpperCase()
    for (const inv of openInvoices) {
      if ((inv.currency || "USD").toUpperCase() !== feedCurrency) continue
      const invAmount = Math.abs(Number(inv.amount))
      if (!Number.isFinite(invAmount) || invAmount === 0) continue
      if (Math.abs(amount - invAmount) <= Math.max(invAmount * 0.2, 50)) return true
    }
  }

  return false
}

/**
 * Does this feed belong in the owner's books? Everything that is not positively a client
 * invoice payment — including anything the system does not recognise.
 */
export function isOwnerLedgerFeed(feed: ProjectableFeed, openInvoices: OpenInvoiceRef[] = []): boolean {
  return !isClientInvoicePayment(feed, openInvoices)
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
    entity_id: TD_ENTITY_ID, // HARD-PINNED — never derived from the feed.
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
 * "This is mine" — Antonio sends a Bank Feed row to My Finances by hand.
 *
 * The mirror of `sendOwnerLedgerRowToFinance`. The automatic rule keeps anything that COULD
 * be a client payment in Finance (a stale pinned candidate, or an amount near an open
 * invoice); when Antonio looks at it and says "no, that's my money", his judgment overrides
 * the rule's caution — a human decision, not a wording guess. First real case: the June 2026
 * Relay "Partner Payout Program" deposit held hostage by a wrong Legerra candidate.
 *
 * Copies FIRST, marks after (the same discipline as the sweep), and clears any stale
 * candidate pin so the row doesn't carry a dead invoice reference into the owner's books.
 * Refuses a `matched` feed outright: that money settled a client invoice — moving it would
 * contradict a completed reconciliation, and undoing a settlement is a deliberate separate
 * act, not a routing click.
 */
export async function sendFeedToOwnerLedger(
  feedId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: feed, error: readErr } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id, matched_payment_id")
    .eq("id", feedId)
    .maybeSingle()

  if (readErr) return { ok: false, error: `Could not read the transaction: ${readErr.message}` }
  if (!feed) return { ok: false, error: "Transaction not found." }
  if (feed.status === "matched") {
    return { ok: false, error: "This transaction already settled a client invoice — unlink it there first." }
  }
  if (feed.status === "owner_ledger") return { ok: true } // already home

  const row = buildOwnerLedgerRow(feed as ProjectableFeed)
  if (!row) return { ok: false, error: "This transaction cannot be moved safely (bad date or amount)." }

  // COPY FIRST — the row must exist in My Finances before it leaves the Bank Feed.
  const { error: insErr } = await supabaseAdmin
    .from("td_books_transactions")
    .upsert([row], { onConflict: "entity_id,transaction_ref", ignoreDuplicates: true })
  if (insErr) return { ok: false, error: `Could not copy it into My Finances: ${insErr.message}` }

  // MARK AFTER — and drop any stale candidate pin with it.
  const res = await updateFeeds([feedId], { status: "owner_ledger", matched_payment_id: null, match_confidence: null }, "owner-ledger-manual-claim")
  if (!res.ok) return { ok: false, error: res.error ?? "Copied, but could not update the Bank Feed row." }
  return { ok: true }
}

/**
 * "This is for a client" — send a transaction back from My Finances to the Bank Feed.
 *
 * The escape hatch that makes the default safe (Antonio, 2026-07-27): anything the system
 * cannot positively identify lands in My Finances, and one click returns it to Finance for
 * invoice matching. Without this the default would be a trap; with it, a wrong guess costs
 * one click.
 *
 * REMOVES the copy from the owner's books before restoring the feed. Leaving it would count
 * the money TWICE — once in Antonio's books and again against the client's invoice — so
 * "fixing" a misroute would create a bookkeeping error. Delete first: if the delete fails we
 * stop and the row stays put, rather than existing in both places.
 */
export async function sendOwnerLedgerRowToFinance(
  feedId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error: delErr } = await supabaseAdmin
    .from("td_books_transactions")
    .delete()
    .eq("entity_id", TD_ENTITY_ID)
    .eq("transaction_ref", `feed:${feedId}`)

  if (delErr) return { ok: false, error: `Could not remove it from My Finances: ${delErr.message}` }

  // Back to the review queue, where the matcher and staff can work it.
  const res = await updateFeeds([feedId], { status: "unmatched" }, "owner-ledger-send-to-finance")
  if (!res.ok) return { ok: false, error: res.error ?? "Could not return it to the Bank Feed." }
  return { ok: true }
}

/**
 * Every invoice a client could still be paying — the veto list for `isClientInvoicePayment`.
 * Uses the ONE shared matchability predicate rather than a hand-written status list, because
 * this codebase has already been burned by four divergent definitions of "open invoice".
 * A Partial invoice is compared on what is still owed, exactly as the matcher does.
 */
async function fetchOpenInvoices(): Promise<OpenInvoiceRef[]> {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("amount, total, amount_due, amount_paid, amount_currency, status, invoice_status, is_test")
  if (error || !data) return []

  const out: OpenInvoiceRef[] = []
  for (const inv of data) {
    if (inv.is_test === true) continue
    if (!isMatchableInvoice(inv as { status?: string | null; invoice_status?: string | null })) continue
    const total = Number(inv.total ?? inv.amount ?? 0)
    const paid = Number(inv.amount_paid ?? 0)
    const outstanding = Number.isFinite(total) && total > 0 ? total - (Number.isFinite(paid) ? paid : 0) : total
    // Both the full figure and the remaining balance count as "something a client owes".
    if (Number.isFinite(total) && total > 0) out.push({ amount: total, currency: inv.amount_currency })
    if (Number.isFinite(outstanding) && outstanding > 0 && outstanding !== total) {
      out.push({ amount: outstanding, currency: inv.amount_currency })
    }
  }
  return out
}

/**
 * The scheduled sweep: anything that is not positively a client invoice payment is copied to
 * My Finances and taken out of the Bank Feed. Runs each cycle before the invoice matcher.
 *
 * `matched` feeds are still COPIED (their money is TD's) but never re-labelled — that status
 * carries the invoice link. The copy is an upsert on a deterministic ref, so re-running is
 * harmless. Ordered and status-scoped so nothing can silently fall outside the window.
 */
export async function sweepFeedsToOwnerLedger(): Promise<ProjectionResult> {
  const openInvoices = await fetchOpenInvoices()

  // 'matched' and 'duplicate' can NEVER project (a matched feed carries client-payment
  // evidence; a duplicate is the same money as another row) — fetching them only burns
  // the window. Left in, they eventually crowd out backfilled history entirely: matched
  // rows never leave 'matched', so once they exceed the limit, older rows would never
  // be seen by any sweep again (bug-hunter, Phase 2 review).
  const { data, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id, matched_payment_id")
    .not("status", "in", '("owner_ledger","matched","duplicate")')
    .order("transaction_date", { ascending: false })
    .limit(2000)

  if (error) {
    return { ok: false, considered: 0, projected: 0, skipped: 0, error: error.message }
  }
  return projectFeedsToOwnerLedger((data ?? []) as ProjectableFeed[], { markFeeds: true, openInvoices })
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
  opts: { markFeeds?: boolean; openInvoices?: OpenInvoiceRef[] } = {},
): Promise<ProjectionResult> {
  const rows: OwnerLedgerRow[] = []
  const markable: string[] = []
  for (const feed of feeds) {
    if (!isOwnerLedgerFeed(feed, opts.openInvoices ?? [])) continue
    const row = buildOwnerLedgerRow(feed)
    if (!row) continue
    rows.push(row)
    // Never re-label a settled feed: `matched` carries the link to the invoice it paid, and
    // the 1-invoice-many-feeds guard keys on it. Copy it to the owner's books, but leave the
    // feed's status alone.
    if (feed.status !== "matched") markable.push(feed.id)
  }

  // Belt-and-braces: the invariant is asserted again at the boundary, not just assumed.
  const stray = rows.find((r) => r.entity_id !== TD_ENTITY_ID)
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

  // INSERT-ONCE, never update (architect blocker, Phase 1a): a books row is STATEFUL the
  // moment Antonio categorizes it — an upsert that rewrites the payload would reset his
  // category/notes on every sweep cycle. Identity is (entity, ref) alone; date/amount are
  // payload, so an upstream feed correction conflicts instead of duplicating.
  const { error } = await supabaseAdmin
    .from("td_books_transactions")
    .upsert(rows, { onConflict: "entity_id,transaction_ref", ignoreDuplicates: true })

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
