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
import { updateFeed, updateFeeds } from "@/lib/finance/feed-write"
import {
  isHumanOwnerClaim,
  ownerRoutingMetadata,
  readOwnerRouting,
  readRejectedPairs,
} from "@/lib/finance/feed-vocabulary"
import {
  matchPayerToRoster,
  matchesExpectedPayment,
  type ClientRosterEntry,
  type ExpectedPayment,
} from "@/lib/finance/client-payer-evidence"
import {
  buildTaughtPayerIndex,
  taughtClientsFor,
  type TaughtMapping,
  type TaughtPayerIndex,
} from "@/lib/finance/payer-learning-rules"

import { reportSystemError } from "@/lib/system-errors"
import { validatePaymentPlan } from "@/lib/offers/payment-plan"

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
  /** Carries the human-triage record (rejected pairs, contested set). Read as EVIDENCE that a
   *  person has already considered this money against a client invoice. */
  review_metadata?: unknown
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
/**
 * Extra evidence the router consults when the caller can supply it.
 *
 * Optional on purpose: `isClientInvoicePayment` keeps its original two-argument shape, so every
 * existing caller and test is unaffected and the new evidence is additive rather than a
 * rewrite of a rule that guards client money.
 */
export interface ClientEvidenceContext {
  /** Every client name money could plausibly come FROM — companies and people. */
  roster?: ClientRosterEntry[]
  /** Amounts a client was told to pay (payment-plan instalments). */
  expected?: ExpectedPayment[]
  /**
   * Payers a human has explicitly taught, indexed for in-memory lookup. Strongest evidence
   * available for a payer the bank cannot describe usefully — because a person supplied it.
   */
  taught?: TaughtPayerIndex
}

export function isClientInvoicePayment(
  feed: ProjectableFeed,
  openInvoices: OpenInvoiceRef[] = [],
  evidence: ClientEvidenceContext = {},
): boolean {
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

  // ⛔ A HUMAN HAS ALREADY TRIAGED THIS AS CLIENT MONEY (2026-07-29).
  // Rejecting a candidate, or un-matching a wrong match, clears the invoice pointer and returns
  // the transaction to `unmatched` — stripping exactly the evidence the checks above rely on. A
  // Mercury wire with no email and no invoice number would then look unrecognised, and this
  // sweep (which runs BEFORE the matcher on every cycle) would move a real client payment into
  // the owner's books, where it is hidden from Finance for everyone and double-counted in the
  // owner P&L against the invoice it is later matched to. A recorded rejection is proof a person
  // considered this money against a client invoice: it stays in Finance.
  if (readRejectedPairs(feed.review_metadata).length > 0) return true

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

  // ── THE AMOUNT A CLIENT WAS TOLD TO SEND (dev job `ae8b8bb1`) ──────────────
  // The band above asks "is this roughly the whole bill?", which a part-payment can never
  // satisfy: Domenico's €1,250 is 50% away from his €2,500 invoice, and no tolerance that
  // admits a half-payment could also refuse a stranger's wire. A payment PLAN removes the
  // guesswork — when the schedule says €1,250 is due, a €1,250 deposit is the expected thing,
  // matched on a tight band (wire fees, not fuzziness). This is what stops payment plans from
  // sweeping every first instalment into the owner's books.
  if (Number.isFinite(amount) && matchesExpectedPayment(amount, feed.currency, evidence.expected ?? [])) {
    return true
  }

  // ── A HUMAN HAS TAUGHT US THIS PAYER ──────────────────────────────────────
  // Sits ABOVE the name rule and below the invoice-number / email / amount evidence, per the
  // agreed precedence. It is the only evidence that can identify a payer the bank describes
  // uselessly — "WM International LLC" has no usable words at all, "Oh My Crea" is truncated,
  // "Relation Box" is reworded, and a call paid on a relative's card carries a name that is
  // CORRECTLY not the client's. No name rule can ever solve those; a person can, once.
  //
  // IDENTIFY, NEVER SETTLE: this keeps the money in Finance and nothing more. It does not pick
  // an invoice, and it must not — a taught payer legitimately pays for SEVERAL clients (proven
  // on the real book), so knowing who sent it can never imply which bill it clears.
  if (evidence.taught && taughtClientsFor(feed, evidence.taught).mappings.length > 0) return true

  // ⛔⛔ ROSTER-DEPENDENT NAME MATCHING IS A REJECTED DESIGN. DO NOT BUILD IT A THIRD TIME.
  //
  // Read this before adding any rule that scans the client roster to identify a payer. It has now
  // been built and taken out TWICE, and a removed commit does not stop a third attempt — which is
  // why the rejection lives here, beside the rule that replaced it, rather than only in history.
  //
  // WHAT WAS TRIED (both times): match a bank descriptor against the names of all clients, and keep
  // the money in Finance when a name looks like a match.
  //
  // WHY IT IS DISQUALIFIED — and it is the SHAPE, not any particular bug in it:
  // A rule that reads the LIVE CLIENT ROSTER is not deterministic. The same transaction classifies
  // differently as the roster changes: create a client, rename one, and money routes differently
  // with no code change and no failing test. A money decision has to be replayable from the
  // transaction and the invoice alone. Nothing in a test suite can catch a rule whose inputs are
  // the whole customer list.
  //
  // THE INCIDENT THAT SETTLED IT (2026-07-22): one shared word sent a $1,000 wire from LC Marketing
  // onto Aces Marketing's invoice. Guessing identity from names IS the mechanism of that incident.
  //
  // THE SECOND ATTEMPT, INSIDE THIS BRANCH, RELEARNED IT IN THREE COMMITS: added, then patched
  // because a one-word client name was claiming a payout, then removed. THE PATCH IN THE MIDDLE IS
  // THE TELL — it was already producing wrong answers before it came out. A rule that needs a
  // special case for short names on its first contact with real data is not one special case short
  // of working.
  //
  // THE RULE THAT STANDS: deterministic identity only — a payer a human TAUGHT, or a payer name
  // that names ONE client scoped to ONE invoice. Amount is CONTEXT, never a reason on its own.
  // If the system does not know, the money goes to My Finances with a button to send it back
  // (Antonio, 2026-07-27). A name guess is the system pretending to know.
  //
  // (Original note, kept: removed deliberately, architect-approved 2026-08-09, after it was built,
  // measured, and found to be the wrong mechanism for a MONEY decision.)
  //
  // Three reasons, in the order that matters:
  //
  //  1. IT MADE ROUTING A FUNCTION OF THE LIVE CLIENT ROSTER. The consolidated name rule is
  //     scoped to ONE invoice's client, which makes it pure, deterministic and replayable. A
  //     scan across every client is none of those: creating or renaming a client changes how
  //     money routes, and no test fails. That property is explicitly rejected in the shared
  //     module's own header, and this code had quietly reintroduced it.
  //  2. GUESSING IDENTITY FROM NAMES IS THE MECHANISM OF THE 2026-07-22 INCIDENT, where one
  //     shared word sent a $1,000 wire to another company's invoice.
  //  3. IT IS FAITHFUL TO THE STANDING DIRECTIVE (Antonio, 2026-07-27): if the system does not
  //     know, the money goes to My Finances with a button to send it back. A name guess is the
  //     system pretending to know.
  //
  // Identity now comes ONLY from evidence that is pure and explicit: the certain links above,
  // and a payer a human TAUGHT. The roster still feeds `describeOwnerLedgerConcern`, but there
  // it is a HINT on a screen a person reads — never an identification, and never routing.
  //
  // ACCEPTED COST, stated so nobody "restores" this as an optimisation: the first payment from a
  // clearly-named client is no longer auto-kept in Finance. It lands in the owner's books and
  // appears in the triage list, where one click teaches the payer. From then on recognition is
  // deterministic and permanent. Antonio accepted that trade explicitly.
  return false
}

/**
 * Why a row that is about to be filed as the owner's money still looks client-shaped — the
 * SIGNAL, which is a different job from the routing decision above.
 *
 * ⛔ THE SILENCE WAS THE REAL DEFECT. Domenico's €1,250 was filed as the owner's money and
 * nothing told anyone: the sweep reports counts into a cron payload nobody reads, and a row
 * filed as owner money is hidden from the Bank Feed for every user. Two days passed. Routing
 * can only ever be as good as its evidence, so the honest answer is not "make the rule
 * perfect" — it is to say out loud when the rule was unsure.
 *
 * Deliberately looser than the routing test, and that asymmetry is the established convention
 * here: strict rules decide, hints tell people. A partial name hit identifies nobody and must
 * never move money, but it is exactly what a human needs in order to look.
 */
export interface OwnerLedgerConcern {
  reason:
    | "named_client_no_amount_fit"
    | "client_named_in_description"
    | "partial_name_match"
    | "taught_payer"
  /** Plain-English sentence for the notice. */
  detail: string
  suspectedClientId?: string
  suspectedClientName?: string
}

/**
 * ALERT vs TRIAGE — two different jobs, deliberately different sensitivities.
 *
 * `alert` is a notification nobody asked for, so it must be worth interrupting someone: payer
 * field only, and a partial match needs at least two words. Measured on the real book, the
 * generous version fired on 27 of 64 rows, all correctly filed — a channel that behaves like
 * that gets ignored, and then the one row that mattered gets ignored with it.
 *
 * `triage` is a screen a person opens on purpose, with the payer and origin in front of them. It
 * can afford to be generous: it also reads the reference and the memo, so a client named only in
 * a description (a wire routed through Wise, an intermediary's descriptor) still shows up as
 * something to look at. Nothing here acts on its own either way.
 */
export type ConcernLens = "alert" | "triage"

export function describeOwnerLedgerConcern(
  feed: ProjectableFeed,
  /**
   * DELIBERATELY UNUSED, and kept only so callers that pass positionally do not shift their
   * remaining arguments. The branch that consumed it — selecting a row because its amount fitted
   * some open invoice — was removed on purpose (see the note above `return null`): on a real book
   * almost any of TD's own payouts fits one by amount, so it surfaced the owner's own money on a
   * triage screen, which is worse than surfacing nothing.
   *
   * Silencing this with an underscore rather than deleting the parameter is the conservative
   * choice: the tests call it positionally, and a signature change would quietly re-map their
   * third and fourth arguments.
   */
  _openInvoices: OpenInvoiceRef[] = [],
  evidence: ClientEvidenceContext = {},
  lens: ConcernLens = "alert",
): OwnerLedgerConcern | null {
  if (feed.status === "outgoing") return null // money leaving is never a client paying

  const amount = Math.abs(typeof feed.amount === "string" ? Number(feed.amount) : feed.amount)
  const payer = feed.sender_name?.trim() || "an unnamed payer"

  const payerMatch = evidence.roster?.length
    ? matchPayerToRoster([feed.sender_name], evidence.roster)
    : null
  // On the triage screen a client named in the DESCRIPTION is still worth a look — but it must
  // never be presented as the payer. Replaying the real book produced "possible payment from Cash
  // Cow Consulting" for a Mercury bonus, purely because the memo begins "Cash bonus". The row is
  // fine to show; asserting who sent it is not. So the wording carries the uncertainty, the same
  // way the audit panel labels a partial hit instead of rounding it up to an identification.
  const descriptionMatch =
    lens === "triage" && evidence.roster?.length && !payerMatch?.named
      ? matchPayerToRoster([feed.sender_reference, feed.memo], evidence.roster)
      : null
  const match = payerMatch?.named ? payerMatch : (descriptionMatch ?? payerMatch)
  const matchedInDescription = !payerMatch?.named && !!descriptionMatch?.named

  // A full name match means the router already kept it in Finance, so reaching here with one
  // can only happen when the caller routed WITHOUT the roster — worth saying rather than
  // swallowing, because it means the sweep ran without the evidence it should have had.
  if (match?.named) {
    const money = `${amount} ${(feed.currency || "USD").toUpperCase()}`
    return {
      reason: matchedInDescription ? "client_named_in_description" : "named_client_no_amount_fit",
      detail: matchedInDescription
        ? `A deposit of ${money} from "${payer}" was filed as your own money, and its description mentions ` +
          `${match.named.entry.name}. That is NOT proof they sent it — a bank description also names ` +
          `intermediaries and referred companies — but it is worth one look before it stays in your books.`
        : `A deposit of ${money} from "${payer}" was filed as your own money, ` +
          `but the payer name identifies a client (${match.named.entry.name}). If this is their payment, send it back to ` +
          `the Bank Feed so it can settle their invoice.`,
      suspectedClientId: match.named.entry.id,
      suspectedClientName: match.named.entry.name ?? undefined,
    }
  }

  if (match?.weak) {
    return {
      reason: "partial_name_match",
      detail:
        `A deposit of ${amount} ${(feed.currency || "USD").toUpperCase()} from "${payer}" was filed as your own money. ` +
        `The name partly matches a client (${match.weak.entry.name}) — too little to decide automatically, ` +
        `so someone should look: a bank that truncates or reformats a company name looks exactly like this.`,
      suspectedClientId: match.weak.entry.id,
      suspectedClientName: match.weak.entry.name ?? undefined,
    }
  }

  // ⛔ AMOUNT ALONE NEVER SELECTS A ROW — the branch that once did is GONE, in both lenses.
  //
  // It read as a reasonable hint and was not: on a real book with hundreds of open invoices,
  // almost ANY of TD's own payouts fits one by amount. Proven by the cell-0 inverse, where a
  // $1,019.25 Stripe payout was offered as possible client money on exactly this basis.
  // Surfacing the owner's own money on a triage screen is worse than surfacing nothing, because
  // then the screen is not worth opening.
  //
  // My own 96-row replay missed this by running with an EMPTY open-invoice list, so the branch
  // could never fire — the measurement answered a different question than the one asked. The
  // amount is still shown on a row selected for a real reason; it is no longer a reason itself.
  return null
}

/**
 * Does this feed belong in the owner's books? Everything that is not positively a client
 * invoice payment — including anything the system does not recognise.
 */
export function isOwnerLedgerFeed(
  feed: ProjectableFeed,
  openInvoices: OpenInvoiceRef[] = [],
  evidence: ClientEvidenceContext = {},
): boolean {
  return !isClientInvoicePayment(feed, openInvoices, evidence)
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
    .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id, matched_payment_id, review_metadata")
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
  //
  // Stamped as a HUMAN claim (dev job `ae8b8bb1`): this is Antonio looking at a row and saying
  // "that is my money". The recovery pass must never quietly reverse that, and before this stamp
  // existed there was no way for it to tell his decision apart from the rule's guess.
  const res = await updateFeed(
    feedId,
    {
      status: "owner_ledger",
      matched_payment_id: null,
      match_confidence: null,
      review_metadata: ownerRoutingMetadata(
        "human",
        new Date().toISOString(),
        "claimed by a person from the Bank Feed",
      ),
    },
    "owner-ledger-manual-claim",
  )
  if (!res.ok) return { ok: false, error: res.error ?? "Copied, but could not update the Bank Feed row." }
  return { ok: true }
}

/**
 * Client money that may be sitting in the owner's books — the recovery list.
 *
 * READ-ONLY, and that is a deliberate design decision rather than a limitation. It would be
 * easy to have this return the strong matches to Finance automatically, and tempting, because
 * one of them is a live client mid-formation. Two reasons not to:
 *
 *  1. Antonio's standing rule for this cleanup is one row at a time, payer and origin shown
 *     before anything happens, never in bulk — five of the seven live credits are partner money
 *     and this book has already taught us what a well-meaning sweep costs.
 *  2. Rows filed before provenance existed cannot prove they were not a human's decision. An
 *     automatic pass over them could silently undo a deliberate claim.
 *
 * So the machine finds and explains; a person decides, using the return action that already
 * exists. Rows a human explicitly claimed are excluded outright.
 */
export interface MisroutedCandidate {
  feedId: string
  transactionDate: string
  amount: number
  currency: string
  payer: string | null
  source: string | null
  reason: OwnerLedgerConcern["reason"]
  detail: string
  suspectedClientName?: string
  suspectedClientId?: string
  /** Provenance: 'sweep' | 'unknown' — a human claim is never listed. */
  filedBy: "sweep" | "unknown"
}

export async function listMisroutedClientPaymentCandidates(): Promise<{
  ok: boolean
  candidates: MisroutedCandidate[]
  considered: number
  error?: string
}> {
  const [openInvoices, roster, taught] = await Promise.all([
    fetchOpenInvoices(),
    fetchClientRoster(),
    fetchTaughtPayerIndex(),
  ])

  const { data, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id, matched_payment_id, review_metadata")
    .eq("status", "owner_ledger")
    .order("transaction_date", { ascending: false })
    .limit(2000)

  if (error) return { ok: false, candidates: [], considered: 0, error: error.message }

  const feeds = (data ?? []) as ProjectableFeed[]

  // ⛔ DIRECTION MUST COME FROM THE BOOKS COPY, NOT THE FEED ROW. Marking a row `owner_ledger`
  // OVERWRITES `status='outgoing'`, so the feed no longer remembers which way the money went —
  // and feeds store an unsigned amount. Without this, an outgoing payment whose descriptor
  // happens to name a client (a real one reads "James - 2024 Tax Returns Sent By Antonio
  // Durante", and "James" is a contact) would be offered as a client payment to recover. The
  // signed books amount is the only surviving record of direction.
  const outgoingIds = new Set<string>()
  if (feeds.length) {
    const { data: books } = await supabaseAdmin
      .from("td_books_transactions")
      .select("transaction_ref, amount")
      .eq("entity_id", TD_ENTITY_ID)
      .in("transaction_ref", feeds.map((f) => `feed:${f.id}`))
    for (const b of books ?? []) {
      if (Number(b.amount) < 0) outgoingIds.add(String(b.transaction_ref).replace(/^feed:/, ""))
    }
  }

  const candidates: MisroutedCandidate[] = []

  for (const feed of feeds) {
    // A person already decided this one. Their judgment outranks the rule — full stop.
    if (isHumanOwnerClaim(feed.review_metadata)) continue
    if (outgoingIds.has(feed.id)) continue

    const evidence: ClientEvidenceContext = { roster, taught }

    // ⛔ IDENTITY ONLY — never "the router would keep this".
    //
    // I first asked `isClientInvoicePayment` here, reasoning that "the rule as it stands today
    // would keep this in Finance" was the strongest available signal. Cell 0 disproved it: that
    // function also returns true on the PRE-EXISTING amount band (within 20% of any open
    // invoice, same currency), which is deliberately over-cautious because for ROUTING the
    // failure is cheap — money stays in Finance and a human moves it. For this LIST the same
    // band is noise: a $1,019.25 Stripe payout was offered as possible client money purely
    // because a sandbox invoice sat near that figure, and on a real book most of TD's own
    // payouts would qualify.
    //
    // So a row reaches this list only when something IDENTIFIES a client — a payer a human
    // taught, or a payer name that names one. Amount never selects; it is only ever context.
    const taughtHere = taughtClientsFor(feed, taught).mappings
    const named = matchPayerToRoster([feed.sender_name], roster).named
    const concern = describeOwnerLedgerConcern(feed, openInvoices, evidence, "triage")
    if (taughtHere.length === 0 && !named && !concern) continue

    candidates.push({
      feedId: feed.id,
      transactionDate: feed.transaction_date,
      amount: Math.abs(Number(feed.amount)) || 0,
      currency: (feed.currency || "USD").toUpperCase(),
      payer: feed.sender_name ?? null,
      source: feed.source ?? null,
      reason: concern?.reason ?? (named ? "named_client_no_amount_fit" : "taught_payer"),
      detail:
        concern?.detail ??
        (named
          ? `The payer name identifies ${named.entry.name}. If this is their payment, send it back to the Bank Feed so it can settle their invoice.`
          : `A payer you taught points at this client. If this deposit is theirs, send it back to the Bank Feed.`),
      ...(named?.entry.name ? { suspectedClientName: named.entry.name } : {}),
      ...(named?.entry.id ? { suspectedClientId: named.entry.id } : {}),
      filedBy: readOwnerRoutingBy(feed.review_metadata),
    })
  }

  return { ok: true, candidates, considered: feeds.length }
}

function readOwnerRoutingBy(meta: unknown): "sweep" | "unknown" {
  const prov = readOwnerRouting(meta)
  return prov?.by === "sweep" ? "sweep" : "unknown"
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
 * Every name money could plausibly come FROM — the client-name evidence the router was missing.
 *
 * Loaded fresh per sweep rather than cached: a client who signed this morning must be
 * recognised this afternoon. The owner's own entity is filtered out in the matcher (by id — see
 * `client-payer-evidence.ts` for why a name test cannot be trusted to exclude itself).
 *
 * Closed and inactive clients are INCLUDED on purpose: a closed account can still send money —
 * one of the ten rows found in the 2026-08-09 audit is a $300 deposit from a client whose
 * account is closed — and forgetting them is how their payment becomes the owner's money.
 */
async function fetchClientRoster(): Promise<ClientRosterEntry[]> {
  const roster: ClientRosterEntry[] = []

  const { data: accounts } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name")
    .order("created_at", { ascending: true })

  for (const a of accounts ?? []) {
    if (a.company_name) roster.push({ id: a.id, name: a.company_name, kind: "account" })
  }

  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name")
    .order("created_at", { ascending: true })

  for (const c of contacts ?? []) {
    if (c.full_name) roster.push({ id: c.id, name: c.full_name, kind: "contact" })
  }

  return roster
}

/**
 * Every payer a human has taught, as an in-memory index.
 *
 * Loaded once per pass rather than queried per transaction: a sweep walks up to 2,000 rows and
 * this is advisory evidence, so it must not cost a round-trip each. Live rows only — a removed
 * mapping is invisible here, which is what makes "unteach" real.
 */
async function fetchTaughtPayerIndex(): Promise<TaughtPayerIndex> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const { data } = await (supabaseAdmin as any)
    .from("payer_client_map")
    .select("id, source, key_type, key_value, account_id, contact_id, display_payer, taught_by, taught_at")
    .is("removed_at", null)

  return buildTaughtPayerIndex((data ?? []) as TaughtMapping[])
}

/**
 * Amounts the system is already EXPECTING from clients — the parts of live payment plans.
 *
 * ⛔ Council blocker, 2026-08-11: `matchesExpectedPayment` existed and the router consulted
 * `evidence.expected`, but NO production caller ever built the list — the comment claimed a
 * protection that was inert (failure pattern #6 in the offers doc, found by the project
 * director). This loader is the wiring.
 *
 * WHY IT MATTERS: a client on a plan wires a later part when their trigger happens — possibly
 * BEFORE staff raise that part's invoice. With no invoice open at that amount, the deposit
 * carries none of the router's positive evidence, and this sweep (which runs before the matcher)
 * would file a real client payment into the owner's books: the exact Domenico misfile this
 * module's header cites as its reason to exist.
 *
 * Shape: every part of every plan on a live (non-final) plan-bearing offer, minus parts that
 * already have a live tranche invoice (those are covered by the open-invoice band once raised,
 * and by the matcher once sent). Narrow-cast reads because the generated types predate the
 * plan/tranche columns. Fail-open to an empty list: a read error must not stop the sweep, and an
 * empty list is exactly the pre-plan behaviour.
 */
async function fetchExpectedPlanPayments(): Promise<ExpectedPayment[]> {
  try {
    const offersQuery = supabaseAdmin
      .from("offers")
      .select("token, status, payment_plan" as never)
      .not("payment_plan" as never, "is", null) as unknown as {
        then: PromiseLike<{ data: Array<{ token: string; status: string | null; payment_plan?: unknown }> | null }>["then"]
      }
    const { data: planOffers } = await offersQuery
    if (!planOffers?.length) return []

    const live = planOffers.filter((o) => !["superseded", "cancelled", "declined"].includes(o.status ?? ""))
    if (!live.length) return []

    const tranchesQuery = supabaseAdmin
      .from("payments")
      .select("tranche_offer_token, tranche_seq, invoice_status" as never)
      .in("tranche_offer_token" as never, live.map((o) => o.token) as never) as unknown as {
        then: PromiseLike<{ data: Array<{ tranche_offer_token: string; tranche_seq: number; invoice_status: string | null }> | null }>["then"]
      }
    const { data: trancheRows } = await tranchesQuery
    const raisedLive = new Set(
      (trancheRows ?? [])
        .filter((r) => !["Cancelled", "Voided", "Credit"].includes(r.invoice_status ?? ""))
        .map((r) => `${r.tranche_offer_token}:${r.tranche_seq}`),
    )

    return expectedPartsFromPlans(live, raisedLive)
  } catch {
    return [] // fail open — empty is the pre-plan behaviour, and the sweep must not stop
  }
}

/**
 * PURE CORE of the expected-payments loader: which plan parts is the system still waiting on?
 * A part with a LIVE tranche invoice is excluded (covered by the open-invoice band once raised);
 * a malformed stored plan contributes nothing rather than throwing — the sweep must never die
 * on one bad row.
 */
export function expectedPartsFromPlans(
  offers: Array<{ token: string; payment_plan?: unknown }>,
  raisedLive: Set<string>,
): ExpectedPayment[] {
  const expected: ExpectedPayment[] = []
  for (const o of offers) {
    const parsed = validatePaymentPlan(o.payment_plan)
    if (!parsed.ok || !parsed.plan) continue
    for (const part of parsed.plan) {
      if (raisedLive.has(`${o.token}:${part.seq}`)) continue
      expected.push({
        amount: part.amount,
        currency: part.currency,
        label: `part ${part.seq} of ${parsed.plan.length} on offer ${o.token}`,
      })
    }
  }
  return expected
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
  const roster = await fetchClientRoster()
  const taught = await fetchTaughtPayerIndex()
  const expected = await fetchExpectedPlanPayments()

  const { data, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id, matched_payment_id, review_metadata")
    .not("status", "in", '("owner_ledger")')
    .order("transaction_date", { ascending: false })
    .limit(2000)

  if (error) {
    return { ok: false, considered: 0, projected: 0, skipped: 0, error: error.message }
  }
  return projectFeedsToOwnerLedger((data ?? []) as ProjectableFeed[], {
    markFeeds: true,
    openInvoices,
    roster,
    taught,
    expected,
  })
}

export interface ProjectionResult {
  ok: boolean
  considered: number
  projected: number
  skipped: number
  /** Feeds marked `owner_ledger` so the Bank Feed stops showing them to staff. */
  marked?: number
  /** Filed as the owner's money but client-shaped — a notice was raised for each. */
  flagged?: number
  error?: string
}

/**
 * Project every owner-ledger feed into My Finances. Idempotent: upserts on the table's real
 * unique key, so a re-run refreshes rather than duplicates. Never writes a client account.
 */
export async function projectFeedsToOwnerLedger(
  feeds: ProjectableFeed[],
  opts: {
    markFeeds?: boolean
    openInvoices?: OpenInvoiceRef[]
    roster?: ClientRosterEntry[]
    expected?: ExpectedPayment[]
    taught?: TaughtPayerIndex
  } = {},
): Promise<ProjectionResult> {
  const evidence: ClientEvidenceContext = { roster: opts.roster, expected: opts.expected, taught: opts.taught }
  const rows: OwnerLedgerRow[] = []
  const markable: string[] = []
  /** Rows filed as the owner's money that still look client-shaped — each gets told. */
  const concerns: Array<{ feed: ProjectableFeed; concern: OwnerLedgerConcern }> = []
  for (const feed of feeds) {
    // ⛔ FORWARD-ONLY. A row that is ALREADY filed is never re-examined here, so improving the
    // routing rule can never retroactively re-file, re-notify, or re-stamp the existing book.
    // History moves one row at a time, by a person, through the triage list — never in bulk.
    //
    // The sweep's own query already excludes these rows, but a promise about client money must
    // not rest on a caller remembering to filter. Enforced here so it holds for every caller.
    if (feed.status === "owner_ledger") continue
    if (!isOwnerLedgerFeed(feed, opts.openInvoices ?? [], evidence)) continue
    const row = buildOwnerLedgerRow(feed)
    if (!row) continue
    rows.push(row)
    const concern = describeOwnerLedgerConcern(feed, opts.openInvoices ?? [], evidence)
    if (concern) concerns.push({ feed, concern })
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

    // WHO filed this row — stamped per row, because the bulk writer cannot merge per-row jsonb
    // (and refuses to try). Written AFTER the status so a failure here leaves a correctly-filed
    // row with an unknown provenance, never a stamped row that was never filed.
    //
    // This stamp is what later lets a recovery pass tell "the rule guessed" apart from "Antonio
    // decided", which on the row itself were indistinguishable — the write path's context
    // argument is only a log string.
    const at = new Date().toISOString()
    for (const feed of markable) {
      const reason = concerns.find((c) => c.feed.id === feed)?.concern.reason
      const res2 = await updateFeed(
        feed,
        {
          review_metadata: ownerRoutingMetadata(
            "sweep",
            at,
            reason
              ? `filed automatically; flagged as possibly a client's money (${reason})`
              : "filed automatically: nothing identified a client paying an invoice",
          ),
        },
        "owner-ledger-projection:provenance",
      )
      if (!res2.ok) {
        console.warn(`[owner-ledger] provenance stamp failed for feed ${feed} (non-fatal): ${res2.error}`)
      }
    }
  }

  // ── TELL SOMEONE (dev job `ae8b8bb1`) ────────────────────────────────────────
  // The silence is what turned one misrouted wire into a two-day outage for a live client.
  // Non-fatal by construction: a notice that cannot be delivered must never stop the money
  // from being recorded. One notice per transaction — the error system fingerprints by shape,
  // so a re-sweep of the same row bumps its count instead of adding noise.
  for (const { feed, concern } of concerns) {
    try {
      await reportSystemError({
        source: "server",
        route: "bank-feed/owner-ledger-possible-client-payment",
        message: concern.detail,
        context: {
          feed_id: feed.id,
          transaction_date: feed.transaction_date,
          amount: feed.amount,
          currency: feed.currency ?? null,
          payer: feed.sender_name ?? null,
          reason: concern.reason,
          suspected_client_id: concern.suspectedClientId ?? null,
          suspected_client_name: concern.suspectedClientName ?? null,
        },
      })
    } catch (err) {
      console.warn(
        `[owner-ledger] client-shaped notice failed for feed ${feed.id} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return {
    ok: true,
    considered: feeds.length,
    projected: rows.length,
    skipped: feeds.length - rows.length,
    marked,
    flagged: concerns.length,
  }
}
