import { describe, it, expect } from "vitest"
import {
  buildOwnerLedgerRow,
  describeOwnerLedgerConcern,
  isClientInvoicePayment,
  isOwnerLedgerFeed,
  projectFeedsToOwnerLedger,
  resolveConfirmedPayoutFeedIds,
  OWNER_ACCOUNT_ID,
  type ProjectableFeed,
  type OpenInvoiceRef,
  expectedPartsFromPlans,
} from "@/lib/finance/owner-ledger-projection"
import type { ClientRosterEntry } from "@/lib/finance/client-payer-evidence"
import type { StripePayoutRow } from "@/lib/finance/stripe-payouts"
import { buildTaughtPayerIndex } from "@/lib/finance/payer-learning-rules"
import {
  isHumanOwnerClaim,
  ownerRoutingMetadata,
  readOwnerRouting,
} from "@/lib/finance/feed-vocabulary"

const base: ProjectableFeed = {
  id: "abc-123",
  transaction_date: "2026-07-24",
  amount: 1019.25,
  currency: "USD",
  source: "relay",
  sender_name: "STRIPE - TRANSFER",
  memo: "STRIPE - TRANSFER",
  status: "needs_review",
}

/**
 * THE RULE (Antonio, 2026-07-27): Finance keeps a deposit ONLY when something concrete proves
 * a client is paying an invoice. Everything else — including anything unrecognised — goes to
 * My Finances, where he can send it back with one click.
 */
describe("isClientInvoicePayment — what STAYS in Finance", () => {
  it("a card charge with its payment reference stays", () => {
    expect(isClientInvoicePayment({ ...base, source: "stripe", raw_data: { payment_intent: "pi_3T5A2O" } })).toBe(true)
  })

  it("an invoice number in the text keeps it in Finance", () => {
    expect(isClientInvoicePayment({ ...base, sender_name: "WISE US INC - INV-001389 -WR", memo: null })).toBe(true)
  })

  it("a payer email keeps it in Finance", () => {
    expect(isClientInvoicePayment({ ...base, memo: "payment from aman@simpleholdingsusa.com" })).toBe(true)
  })

  it("a feed already tied to an invoice stays", () => {
    expect(isClientInvoicePayment({ ...base, matched_payment_id: "pay-1" })).toBe(true)
  })

  it("an amount matching something a client owes keeps it in Finance", () => {
    const owed: OpenInvoiceRef[] = [{ amount: 1000, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, amount: 1019.25 }, owed)).toBe(true)
  })

  it("PART-PAYMENT: $500 against a $2,200 invoice — the wide tolerance keeps it in Finance", () => {
    // The Council broke the earlier rule on exactly this: a client part-payment matched no
    // invoice under a 5% tolerance and was swept out. The veto uses max(20%, $50).
    const owed: OpenInvoiceRef[] = [{ amount: 500, currency: "USD" }, { amount: 2200, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, amount: 500, sender_name: "Some Wire", memo: null }, owed)).toBe(true)
  })

  it("CURRENCY: a EUR deposit is NOT kept by a same-numbered USD invoice", () => {
    const owed: OpenInvoiceRef[] = [{ amount: 1019.25, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, currency: "EUR", sender_name: "Wire", memo: null }, owed)).toBe(false)
  })
})

describe("isOwnerLedgerFeed — what goes to MY FINANCES", () => {
  it("a Stripe payout goes (nothing proves it is a client)", () => {
    expect(isOwnerLedgerFeed(base)).toBe(true)
  })

  it("money TD spent goes", () => {
    expect(isOwnerLedgerFeed({ ...base, status: "outgoing", sender_name: "Tony Durante LLC" })).toBe(true)
  })

  it("a bank reward goes", () => {
    expect(isOwnerLedgerFeed({ ...base, source: "mercury_api", sender_name: "Mercury", memo: "Cash bonus for referring ATCOACHING LLC." })).toBe(true)
  })

  it("THE DEFAULT: an unrecognised deposit goes to My Finances (not left in Finance)", () => {
    expect(isOwnerLedgerFeed({ ...base, sender_name: "Unknown Wire", memo: null, raw_data: {} })).toBe(true)
  })

  it("outgoing money is never treated as a client payment even if it names a client", () => {
    expect(isClientInvoicePayment({ ...base, status: "outgoing", memo: "INV-001389" })).toBe(false)
  })
})

/**
 * THE INCIDENT (2026-08-22): two real Stripe "STRIPE - TRANSFER" payouts were misfiled as
 * maybe-client-money purely because their amount happened to sit near an open invoice — the
 * router had no way to ask Stripe's own payout list "is this actually TD's money?"
 */
describe("confirmed Stripe payout veto — TD's own money beats an amount coincidence", () => {
  it("a deposit CONFIRMED against a real payout is NOT a client payment, even with a same-numbered open invoice", () => {
    const owed: OpenInvoiceRef[] = [{ amount: 1019.25, currency: "USD" }]
    expect(
      isClientInvoicePayment({ ...base, amount: 1019.25 }, owed, {
        confirmedTdPayoutFeedIds: new Set([base.id]),
      }),
    ).toBe(false)
  })

  it("without confirmation, the same deposit falls through to the amount-tolerance fallback and stays in Finance", () => {
    const owed: OpenInvoiceRef[] = [{ amount: 1019.25, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, amount: 1019.25 }, owed)).toBe(true)
  })

  it("a payment-intent Stripe charge still wins over a (implausible) payout-id collision", () => {
    expect(
      isClientInvoicePayment(
        { ...base, source: "stripe", raw_data: { payment_intent: "pi_3T5A2O" } },
        [],
        { confirmedTdPayoutFeedIds: new Set([base.id]) },
      ),
    ).toBe(true)
  })

  it("a CONFIRMED payout overrides a merely PENDING candidate pin (Antonio, 2026-08-22: 'there is no way to guess anything' once Stripe confirms it)", () => {
    const pendingCandidate: ProjectableFeed = { ...base, status: "needs_review", matched_payment_id: "some-unrelated-invoice-id" }
    expect(isClientInvoicePayment(pendingCandidate, [], { confirmedTdPayoutFeedIds: new Set([base.id]) })).toBe(false)
  })

  it("without a confirmed payout, that same pending candidate pin still protects the row (unchanged behaviour)", () => {
    const pendingCandidate: ProjectableFeed = { ...base, status: "needs_review", matched_payment_id: "some-unrelated-invoice-id" }
    expect(isClientInvoicePayment(pendingCandidate, [])).toBe(true)
  })

  it("a TRUE settlement (status: matched) is NEVER overridden by a confirmed payout — reversing a real settlement is a separate decision", () => {
    const settled: ProjectableFeed = { ...base, status: "matched", matched_payment_id: "real-settled-invoice-id" }
    expect(isClientInvoicePayment(settled, [], { confirmedTdPayoutFeedIds: new Set([base.id]) })).toBe(true)
  })
})

describe("looksLikeStripePayoutDeposit — the signature gate (bug-hunter finding, 2026-08-22)", () => {
  it("a real Stripe-worded deposit IS eligible for payout confirmation", () => {
    const payouts: StripePayoutRow[] = [{ id: "po_sig", amount: 500, currency: "usd", arrival_date: "2026-08-01", status: "paid", livemode: true }]
    const feed: ProjectableFeed = { ...base, id: "feed-real", amount: 500, transaction_date: "2026-08-01", sender_name: "STRIPE - TRANSFER", memo: "STRIPE - TRANSFER" }
    expect(resolveConfirmedPayoutFeedIds([feed], payouts).has("feed-real")).toBe(true)
  })

  it("a genuine client wire that COINCIDENTALLY matches a real payout's amount+date+currency is NOT confirmed — it carries no Stripe wording at all", () => {
    const payouts: StripePayoutRow[] = [{ id: "po_coincidence", amount: 500, currency: "usd", arrival_date: "2026-08-01", status: "paid", livemode: true }]
    const clientWire: ProjectableFeed = {
      ...base,
      id: "feed-client-coincidence",
      amount: 500,
      transaction_date: "2026-08-01",
      sender_name: "Some Client LLC",
      memo: "Invoice payment",
      sender_reference: null,
    }
    expect(resolveConfirmedPayoutFeedIds([clientWire], payouts).has("feed-client-coincidence")).toBe(false)
  })

  it("without the signature, that same coincidental deposit falls back to ordinary routing (protected by whatever evidence it actually carries)", () => {
    const clientWire: ProjectableFeed = {
      ...base,
      id: "feed-client-coincidence",
      amount: 500,
      transaction_date: "2026-08-01",
      sender_name: "Some Client LLC",
      memo: "Invoice payment",
      sender_reference: null,
    }
    const evidence = { confirmedTdPayoutFeedIds: resolveConfirmedPayoutFeedIds([clientWire], [{ id: "po_x", amount: 500, currency: "usd", arrival_date: "2026-08-01", status: "paid", livemode: true }]) }
    // Not confirmed as a payout (no signature) — falls through to the default, same as any
    // unrecognised deposit with no evidence at all: goes to My Finances, one click sends it back.
    expect(isClientInvoicePayment(clientWire, [], evidence)).toBe(false)
  })
})

describe("resolveConfirmedPayoutFeedIds — one payout confirms at most one deposit", () => {
  const payouts: StripePayoutRow[] = [
    { id: "po_a", amount: 1019.25, currency: "usd", arrival_date: "2026-07-24", status: "paid", livemode: true },
  ]

  it("the real Stripe payout deposit is confirmed", () => {
    const feed: ProjectableFeed = { ...base, id: "feed-real-payout", amount: 1019.25, transaction_date: "2026-07-24" }
    const confirmed = resolveConfirmedPayoutFeedIds([feed], payouts)
    expect(confirmed.has("feed-real-payout")).toBe(true)
  })

  it("a SECOND same-amount deposit in the same window does NOT also get confirmed — the payout is used once", () => {
    const real: ProjectableFeed = { ...base, id: "feed-real-payout", amount: 1019.25, transaction_date: "2026-07-24" }
    const coincidence: ProjectableFeed = { ...base, id: "feed-client-wire", amount: 1019.25, transaction_date: "2026-07-25", sender_name: "Some Client Wire" }
    const confirmed = resolveConfirmedPayoutFeedIds([real, coincidence], payouts)
    expect(confirmed.has("feed-real-payout")).toBe(true)
    expect(confirmed.has("feed-client-wire")).toBe(false)
  })

  it("the EARLIER-dated deposit claims the payout when two candidates compete (stable, replayable ordering)", () => {
    const later: ProjectableFeed = { ...base, id: "feed-later", amount: 1019.25, transaction_date: "2026-07-26" }
    const earlier: ProjectableFeed = { ...base, id: "feed-earlier", amount: 1019.25, transaction_date: "2026-07-23" }
    // Passed in reverse order on purpose — the resolver must sort, not trust array order.
    const confirmed = resolveConfirmedPayoutFeedIds([later, earlier], payouts)
    expect(confirmed.has("feed-earlier")).toBe(true)
    expect(confirmed.has("feed-later")).toBe(false)
  })

  it("outgoing money is never matched against a payout", () => {
    const feed: ProjectableFeed = { ...base, id: "feed-outgoing", amount: 1019.25, transaction_date: "2026-07-24", status: "outgoing" }
    expect(resolveConfirmedPayoutFeedIds([feed], payouts).size).toBe(0)
  })

  it("a EUR deposit does not get confirmed against a USD payout of the same number", () => {
    const feed: ProjectableFeed = { ...base, id: "feed-eur", amount: 1019.25, currency: "EUR", transaction_date: "2026-07-24" }
    expect(resolveConfirmedPayoutFeedIds([feed], payouts).size).toBe(0)
  })

  it("no payouts synced yet → nothing confirmed (fail-open, pre-fix behaviour)", () => {
    const feed: ProjectableFeed = { ...base, id: "feed-x", amount: 1019.25, transaction_date: "2026-07-24" }
    expect(resolveConfirmedPayoutFeedIds([feed], []).size).toBe(0)
  })
})

/**
 * REPLAY — all FOUR real production td_bank_feeds rows this fix was built for (dev job
 * `8a417a38`), read verbatim from production on 2026-08-22 (values only — no client data;
 * all four are TD's own real Stripe payouts, sender "STRIPE - TRANSFER" via Relay), against
 * the four real `stripe_payouts` rows that confirm them. A full production audit (run this
 * session, not assumed) found four affected rows, not the two originally scoped — two of them
 * ($50.68 and $51.16) share the exact same pending candidate pin (one $53 invoice guessed, by
 * amount proximity alone, as a "maybe" for two unrelated real payouts).
 *
 * ALL FOUR ARE NOW FIXED (Antonio, 2026-08-22: "Stripe Payouts are Stripe Payouts. There is no
 * way to guess anything"): a confirmed real payout now overrides a merely PENDING candidate
 * pin (status not "matched"), closing the gap an earlier version of this fix left open. Only a
 * TRUE settlement (status "matched" — a real, completed reconciliation) still stays protected,
 * and verified separately that no such row exists today that is also a confirmed payout.
 */
describe("REPLAY — the four real production incident rows (2026-08-22)", () => {
  const REAL_PAYOUTS: StripePayoutRow[] = [
    { id: "po_1TyLQAIHsqD3wMA90brP6WcY", amount: 50.68, currency: "usd", arrival_date: "2026-07-29", status: "paid", livemode: true },
    { id: "po_1TyhT9IHsqD3wMA9NV7rWeez", amount: 51.16, currency: "usd", arrival_date: "2026-07-30", status: "paid", livemode: true },
    { id: "po_1U2gfRIHsqD3wMA9SW0LaKai", amount: 1019.25, currency: "usd", arrival_date: "2026-08-10", status: "paid", livemode: true },
    { id: "po_1U33KKIHsqD3wMA9oop8I3nJ", amount: 1324.82, currency: "usd", arrival_date: "2026-08-11", status: "paid", livemode: true },
  ]
  const REAL_ROWS: ProjectableFeed[] = [
    {
      id: "e4b58a7f-e735-4917-9a56-4c305c19aba6",
      transaction_date: "2026-07-29",
      amount: 50.68,
      currency: "USD",
      source: "relay",
      sender_name: "STRIPE - TRANSFER",
      memo: "STRIPE - TRANSFER",
      sender_reference: null,
      status: "needs_review",
      matched_payment_id: "80aa53ff-0d29-4bf4-9b51-b2bed8712fdb", // the SAME $53 invoice, guessed twice
    },
    {
      id: "592b3505-d551-4825-ab5f-24630c8359ea",
      transaction_date: "2026-07-30",
      amount: 51.16,
      currency: "USD",
      source: "relay",
      sender_name: "STRIPE - TRANSFER",
      memo: "STRIPE - TRANSFER",
      sender_reference: null,
      status: "needs_review",
      matched_payment_id: "80aa53ff-0d29-4bf4-9b51-b2bed8712fdb",
    },
    {
      id: "1d1008fa-2897-4a3b-858c-70a907c8dc4f",
      transaction_date: "2026-08-10",
      amount: 1019.25,
      currency: "USD",
      source: "relay",
      sender_name: "STRIPE - TRANSFER",
      memo: "STRIPE - TRANSFER",
      sender_reference: null,
      status: "needs_review",
      matched_payment_id: "0559cf76-cd1c-4805-9cc6-7c8b016a384a",
    },
    {
      id: "ba3e295f-8f6d-4e53-9232-bfb80460f9f5",
      transaction_date: "2026-08-11",
      amount: 1324.82,
      currency: "USD",
      source: "relay",
      sender_name: "STRIPE - TRANSFER",
      memo: "STRIPE - TRANSFER",
      sender_reference: null,
      status: "unmatched",
      matched_payment_id: null,
    },
  ]

  it("all four real deposits are confirmed against their real payouts, each payout used once", () => {
    const confirmed = resolveConfirmedPayoutFeedIds(REAL_ROWS, REAL_PAYOUTS)
    for (const row of REAL_ROWS) expect(confirmed.has(row.id)).toBe(true)
  })

  it("FIXED: all four now correctly route to My Finances, including the two carrying a pending candidate pin", () => {
    const evidence = { confirmedTdPayoutFeedIds: resolveConfirmedPayoutFeedIds(REAL_ROWS, REAL_PAYOUTS) }
    for (const row of REAL_ROWS) {
      expect(isClientInvoicePayment(row, [], evidence)).toBe(false)
      expect(isOwnerLedgerFeed(row, [], evidence)).toBe(true)
    }
  })
})

describe("buildOwnerLedgerRow — the safety rules", () => {
  it("ALWAYS pins the owner account — never a client's", () => {
    expect(buildOwnerLedgerRow(base)!.entity_id).toBe(OWNER_ACCOUNT_ID)
  })

  it("signs the amount — money out negative, money in positive", () => {
    expect(buildOwnerLedgerRow({ ...base, status: "outgoing", amount: 25000 })!.amount).toBe(-25000)
    expect(buildOwnerLedgerRow({ ...base, amount: 1019.25 })!.amount).toBe(1019.25)
  })

  it("produces a non-blank deterministic reference so it can be sent back", () => {
    expect(buildOwnerLedgerRow(base)!.transaction_ref).toBe("feed:abc-123")
  })

  it("derives the tax year, preserves currency, always lands uncategorized", () => {
    const row = buildOwnerLedgerRow({ ...base, transaction_date: "2025-12-31", currency: "eur" })!
    expect(row.tax_year).toBe(2025)
    expect(row.currency).toBe("EUR")
    expect(row.category).toBe("uncategorized")
  })

  it("maps the bank label so cash groups per account", () => {
    expect(buildOwnerLedgerRow({ ...base, source: "mercury_api" })!.bank_name).toBe("Mercury")
  })

  it("refuses a row it cannot build safely rather than corrupting the books", () => {
    expect(buildOwnerLedgerRow({ ...base, amount: Number.NaN })).toBeNull()
    expect(buildOwnerLedgerRow({ ...base, transaction_date: "not-a-date" })).toBeNull()
  })

  it("rounds to cents (no floating-point dust)", () => {
    expect(buildOwnerLedgerRow({ ...base, amount: 0.1 + 0.2 })!.amount).toBe(0.3)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE PART-PAYMENT / PAYER-NAME GAP — dev job `ae8b8bb1` (2026-08-09)
//
// A client wired HALF of his signed offer. His wire carried his name and nothing else. Half is
// 50% away from the invoice total, so the "could this be the bill?" band could not see it, and
// the payer's name was not evidence at all — the router never looked at names. Result: a real
// client payment filed as the owner's own money, out of the matching queue, no alert, two days.
// ════════════════════════════════════════════════════════════════════════════════════════════

const CLIENT_ROSTER: ClientRosterEntry[] = [
  { id: "contact-1", name: "Domenico Cristiano", kind: "contact" },
  { id: "account-1", name: "Vandenberg Logistics", kind: "account" },
  // The owner's own books entity really is a row in `accounts`, really is named after TD.
  { id: OWNER_ACCOUNT_ID, name: "Tony Durante LLC", kind: "account" },
]

const HALF_PAYMENT: ProjectableFeed = {
  id: "feed-half",
  transaction_date: "2026-08-07",
  amount: 1250,
  currency: "EUR",
  source: "airwallex_api",
  sender_name: "Domenico Pio Cristiano",
  memo: "Domenico Pio Cristiano — 010F345262220F28_1",
  sender_reference: "010F345262220F28_1",
  status: "unmatched",
}

const OWED_2500: OpenInvoiceRef[] = [{ amount: 2500, currency: "EUR" }]

describe("the half-payment incident", () => {
  it("REPRODUCES the bug when the router is given no client-name evidence", () => {
    // This is what shipped: same row, same open invoice, filed as the owner's money.
    expect(isClientInvoicePayment(HALF_PAYMENT, OWED_2500)).toBe(false)
    expect(isOwnerLedgerFeed(HALF_PAYMENT, OWED_2500)).toBe(true)
  })

  it("does NOT keep it in Finance on the payer's name alone — roster routing was removed", () => {
    // ⚠️ THIS CELL ASSERTED THE OPPOSITE until roster-wide name matching was removed from
    // routing. Kept and inverted rather than deleted, because the inversion IS the decision:
    // a name is a hint for a human, never a routing fact. Half of a EUR2,500 bill is also 50%
    // outside the amount band, so nothing else rescues it either — it goes to My Finances and
    // appears in triage, which is the accepted cost.
    expect(isClientInvoicePayment(HALF_PAYMENT, OWED_2500, { roster: CLIENT_ROSTER })).toBe(false)
    // A taught payer is what keeps it, and that is deterministic rather than roster-dependent.
    const taught = buildTaughtPayerIndex([{
      id: "m-half", source: "airwallex_api", key_type: "descriptor",
      key_value: "domenico pio cristiano", account_id: null, contact_id: "contact-1",
    }])
    expect(isClientInvoicePayment(HALF_PAYMENT, OWED_2500, { taught })).toBe(true)
  })

  it("keeps it in Finance when a payment plan says that amount is due, even with no name", () => {
    const anonymous = { ...HALF_PAYMENT, sender_name: "WIRE TRANSFER", memo: null, sender_reference: null }
    expect(isClientInvoicePayment(anonymous, OWED_2500)).toBe(false)
    expect(
      isClientInvoicePayment(anonymous, OWED_2500, {
        expected: [{ amount: 1250, currency: "EUR", label: "instalment 1 of 2" }],
      }),
    ).toBe(true)
  })

  it("still files a genuine Stripe payout as the owner's money — the roster must not change that", () => {
    // ⛔ THE REGRESSION GUARD. TD's own name is printed on TD's own payout descriptors. If the
    // owner entity counted as a client, 43 payouts (~$57k) would be dragged back into Finance.
    const payout: ProjectableFeed = {
      ...base,
      sender_name: "STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE",
      memo: "STRIPE; TRANSFER; TONY DURANTE LLC",
    }
    expect(isClientInvoicePayment(payout, [], { roster: CLIENT_ROSTER })).toBe(false)
    expect(isOwnerLedgerFeed(payout, [], { roster: CLIENT_ROSTER })).toBe(true)
  })

  it("REFUSES to read a client's name out of the memo — TD's referral bonus is not their payment", () => {
    // ⛔ FOUND BY REPLAYING THE RULE OVER THE REAL BOOK, not by reasoning. TD's own Mercury
    // referral bonuses carry "Cash bonus for referring <CLIENT> LLC". The memo names a client
    // who is emphatically NOT the payer, and a one-word client name is 100% covered by one
    // token — so a memo-aware rule books TD's own bonus as that client's payment.
    const bonus: ProjectableFeed = {
      ...base,
      source: "mercury_api",
      sender_name: "Mercury",
      memo: "Cash bonus for referring ATCOACHING LLC.",
      amount: 250,
    }
    const roster: ClientRosterEntry[] = [...CLIENT_ROSTER, { id: "account-9", name: "ATCOACHING LLC", kind: "account" }]
    expect(isClientInvoicePayment(bonus, [], { roster })).toBe(false)
    // ...and it must not raise a notice either: one that fires on every correct bonus row
    // teaches people to ignore the one that matters.
    expect(describeOwnerLedgerConcern(bonus, [], { roster })).toBeNull()
  })

  it("still files a partner payout as the owner's money", () => {
    const payout: ProjectableFeed = {
      ...base,
      sender_name: "Relay Financial US Corp - May 2026 Partner Payout Program",
      memo: null,
      amount: 1220.39,
    }
    expect(isClientInvoicePayment(payout, [], { roster: CLIENT_ROSTER })).toBe(false)
  })
})

describe("describeOwnerLedgerConcern — saying it out loud", () => {
  it("⛔ NEVER flags a row on amount alone — not even a perfect part-payment fit", () => {
    // This cell asserted the opposite until cell 0 disproved it: with real open invoices in play,
    // a $1,019.25 Stripe payout was offered as possible client money purely because the amount
    // fitted some invoice. On a real book almost any of TD's own payouts fits one. A triage
    // screen showing the owner's own money is worse than one showing nothing.
    const anonymous = { ...HALF_PAYMENT, sender_name: "WIRE TRANSFER", memo: null, sender_reference: null }
    expect(describeOwnerLedgerConcern(anonymous, OWED_2500)).toBeNull()
    expect(describeOwnerLedgerConcern(anonymous, OWED_2500, {}, "triage")).toBeNull()
  })

  it("stays SILENT on a one-word partial match — measured noise, not a judgement call", () => {
    // Replaying the real book with one-word hints raised a notice on 27 of 64 rows, every one of
    // them correctly filed (TD's own surname on each Stripe payout; the word "Partner" on each
    // Relay payout). A channel like that gets muted, and the row that matters gets muted with it.
    const feed = { ...HALF_PAYMENT, sender_name: "VANDENBERG", memo: null, sender_reference: null }
    expect(isClientInvoicePayment(feed, [], { roster: CLIENT_ROSTER })).toBe(false)
    expect(describeOwnerLedgerConcern(feed, [], { roster: CLIENT_ROSTER })).toBeNull()
  })

  it("on the TRIAGE lens, a client named in the DESCRIPTION is shown but never called the payer", () => {
    const viaIntermediary: ProjectableFeed = {
      ...HALF_PAYMENT,
      sender_name: "WISE US INC",
      sender_reference: "From VANDENBERG LOGISTICS Via WISE",
      memo: null,
    }
    // The alert channel says nothing (the payer field is an intermediary)...
    expect(describeOwnerLedgerConcern(viaIntermediary, [], { roster: CLIENT_ROSTER })).toBeNull()
    // ...but the screen a person opens on purpose shows it, worded as a mention, not a fact.
    const t = describeOwnerLedgerConcern(viaIntermediary, [], { roster: CLIENT_ROSTER }, "triage")
    expect(t?.reason).toBe("client_named_in_description")
    expect(t?.detail).toContain("NOT proof")
    expect(t?.suspectedClientName).toBe("Vandenberg Logistics")
  })

  it("says nothing about TD's own payouts — silence is correct here, noise would be the defect", () => {
    const payout: ProjectableFeed = {
      ...base,
      sender_name: "STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE",
      memo: null,
    }
    expect(describeOwnerLedgerConcern(payout, [], { roster: CLIENT_ROSTER })).toBeNull()
  })

  it("never flags money going OUT", () => {
    expect(describeOwnerLedgerConcern({ ...HALF_PAYMENT, status: "outgoing" }, OWED_2500, { roster: CLIENT_ROSTER })).toBeNull()
  })
})

describe("owner-routing provenance — a human decision outranks the rule", () => {
  it("round-trips both kinds", () => {
    const sweep = ownerRoutingMetadata("sweep", "2026-08-09T10:00:00.000Z", "filed automatically")
    expect(readOwnerRouting(sweep)?.by).toBe("sweep")
    expect(isHumanOwnerClaim(sweep)).toBe(false)

    const human = ownerRoutingMetadata("human", "2026-08-09T10:00:00.000Z")
    expect(isHumanOwnerClaim(human)).toBe(true)
  })

  it("treats an UNSTAMPED row as unknown, not as a human decision", () => {
    // Load-bearing: assuming "human" for the 96 rows filed before provenance existed would
    // freeze the mis-swept client payments this work exists to recover.
    expect(isHumanOwnerClaim(null)).toBe(false)
    expect(isHumanOwnerClaim({ contested: null })).toBe(false)
    expect(readOwnerRouting({ owner_routing: { by: "nonsense" } })).toBeNull()
  })

  it("survives alongside unrelated metadata keys (the column MERGES)", () => {
    const merged = { rejected_pairs: [{ payment_id: "p1", at: "x", by: null }], ...ownerRoutingMetadata("human", "t") }
    expect(isHumanOwnerClaim(merged)).toBe(true)
    expect((merged as { rejected_pairs: unknown[] }).rejected_pairs).toHaveLength(1)
  })
})

describe("forward-only: improving the rule must never rewrite history", () => {
  it("skips a row that is ALREADY filed as the owner's money", async () => {
    // The safety promise Antonio required before this ships: historical rows stay exactly where
    // they are and move one at a time through triage. The sweep's query already excludes them,
    // but a promise about client money must not depend on a caller remembering to filter — so
    // the projector refuses them itself, for every caller.
    const alreadyFiled: ProjectableFeed = {
      ...HALF_PAYMENT,
      status: "owner_ledger",
    }
    const res = await projectFeedsToOwnerLedger([alreadyFiled], {
      markFeeds: true,
      roster: CLIENT_ROSTER,
      openInvoices: OWED_2500,
    })
    // Considered, but nothing projected, nothing marked, nothing flagged — so no database call
    // is reached and no notice is raised. (A projected row would need a live database.)
    expect(res.projected).toBe(0)
    expect(res.marked ?? 0).toBe(0)
    expect(res.flagged ?? 0).toBe(0)
    expect(res.skipped).toBe(1)
  })
})

describe("taught payers in the router [UNIT]", () => {
  const TAUGHT = buildTaughtPayerIndex([
    {
      id: "m1", source: "relay", key_type: "descriptor",
      key_value: "wm international from wm international llc via mercury com",
      account_id: "account-1", contact_id: null,
    },
  ])

  // The descriptor the NAME rule can never see: "wm" is below the length floor and both
  // "international" and "llc" are stop words there, so it has ZERO significant words.
  const UNNAMEABLE: ProjectableFeed = {
    id: "feed-wm",
    transaction_date: "2026-02-19",
    amount: 2300,
    currency: "USD",
    source: "relay",
    sender_name: "WM International - From WM International LLC via mercury.com",
    memo: null,
    status: "unmatched",
  }

  it("recovers a payer the name rule structurally cannot", () => {
    expect(isClientInvoicePayment(UNNAMEABLE, [], { roster: CLIENT_ROSTER })).toBe(false)
    expect(isClientInvoicePayment(UNNAMEABLE, [], { roster: CLIENT_ROSTER, taught: TAUGHT })).toBe(true)
  })

  it("⛔ a roster name NEVER routes on its own any more — only a taught payer does", () => {
    // Roster-wide name matching was removed from routing (architect-approved): it made money
    // routing a function of the live client list, which is the property the shared name module
    // explicitly rejects, and name-guessing is the mechanism of the 2026-07-22 wrong-client
    // incident. A clearly-named client now takes one triage click, then is deterministic.
    const clearlyNamed: ProjectableFeed = {
      ...UNNAMEABLE,
      sender_name: "Domenico Pio Cristiano",
      memo: null,
    }
    expect(isClientInvoicePayment(clearlyNamed, [], { roster: CLIENT_ROSTER })).toBe(false)
    // ...but the hint still tells a human, which is where a name belongs.
    expect(describeOwnerLedgerConcern(clearlyNamed, [], { roster: CLIENT_ROSTER })?.suspectedClientName)
      .toBe("Domenico Cristiano")
  })

  it("does not leak to a different bank or a different payer", () => {
    expect(isClientInvoicePayment({ ...UNNAMEABLE, source: "mercury" }, [], { taught: TAUGHT })).toBe(false)
    expect(isClientInvoicePayment({ ...UNNAMEABLE, sender_name: "Someone Else Entirely" }, [], { taught: TAUGHT })).toBe(false)
  })

  it("still refuses money leaving the account, taught or not", () => {
    expect(isClientInvoicePayment({ ...UNNAMEABLE, status: "outgoing" }, [], { taught: TAUGHT })).toBe(false)
  })
})

describe("ISOLATION: routing must never reach the roster scan [UNIT]", () => {
  /**
   * ⛔ THIS IS THE GUARD ON A DECISION, NOT A FEATURE TEST.
   *
   * Roster-wide name matching was removed from routing because it made a MONEY decision — taken
   * with no human in the loop — depend on the live client list: rename a client and routing
   * changes, with nothing failing. The roster survives only as a hint a person reads.
   *
   * These cells exist so that wiring it back in cannot pass silently. MUTATION-PROVEN: re-adding
   * the roster check to isClientInvoicePayment turns them red (verified by doing it).
   */
  const PERFECT_MATCH_ROSTER: ClientRosterEntry[] = [
    { id: "acct-x", name: "Vandenberg Logistics", kind: "account" },
  ]
  const NAMES_THE_CLIENT_EXACTLY: ProjectableFeed = {
    id: "feed-iso",
    transaction_date: "2026-08-09",
    amount: 4321,
    currency: "USD",
    source: "relay",
    // Covers 100% of the client's significant words — the strongest possible name evidence.
    sender_name: "VANDENBERG LOGISTICS",
    memo: null,
    status: "unmatched",
  }

  it("a PERFECT client-name match does not keep money in Finance", () => {
    expect(isClientInvoicePayment(NAMES_THE_CLIENT_EXACTLY, [], { roster: PERFECT_MATCH_ROSTER })).toBe(false)
    expect(isOwnerLedgerFeed(NAMES_THE_CLIENT_EXACTLY, [], { roster: PERFECT_MATCH_ROSTER })).toBe(true)
  })

  it("passing a roster changes NOTHING about the routing answer", () => {
    const withRoster = isClientInvoicePayment(NAMES_THE_CLIENT_EXACTLY, [], { roster: PERFECT_MATCH_ROSTER })
    const withoutRoster = isClientInvoicePayment(NAMES_THE_CLIENT_EXACTLY, [])
    expect(withRoster).toBe(withoutRoster)
  })

  it("...while the HINT still names that client, which is where a name belongs", () => {
    expect(
      describeOwnerLedgerConcern(NAMES_THE_CLIENT_EXACTLY, [], { roster: PERFECT_MATCH_ROSTER })?.suspectedClientName,
    ).toBe("Vandenberg Logistics")
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  ⛔ THE EXPECTED-PAYMENTS EVIDENCE IS NOW WIRED (council blocker, 2026-08-11)
//
//  `matchesExpectedPayment` existed and the router consulted it, but no production caller ever
//  built the list — a protection that was claimed and inert. These pin the pure core of the
//  loader the sweep now calls.
// ══════════════════════════════════════════════════════════════════════════════════════════


describe("expectedPartsFromPlans — what the system is still waiting on", () => {
  const PLAN = [
    { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
    { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual", label: "when your bank account is opened" } },
  ]

  it("expects every part of a live plan when nothing is raised", () => {
    const exp = expectedPartsFromPlans([{ token: "t1", payment_plan: PLAN }], new Set())
    expect(exp.map((e) => e.amount)).toEqual([1250, 1250])
    expect(exp[1].label).toContain("part 2 of 2")
  })

  it("excludes a part that already has a LIVE tranche invoice", () => {
    // Once raised, the open-invoice band covers it; expecting it twice would widen the net for
    // no reason.
    const exp = expectedPartsFromPlans([{ token: "t1", payment_plan: PLAN }], new Set(["t1:1"]))
    expect(exp.map((e) => e.amount)).toEqual([1250])
    expect(exp[0].label).toContain("part 2")
  })

  it("a malformed stored plan contributes nothing rather than throwing", () => {
    // The sweep must never die on one bad row — it runs before the matcher on every cycle.
    const exp = expectedPartsFromPlans(
      [
        { token: "bad", payment_plan: [{ seq: 1, amount: -5 }] },
        { token: "good", payment_plan: PLAN },
      ],
      new Set(),
    )
    expect(exp).toHaveLength(2)
    expect(exp.every((e) => e.label?.includes("good"))).toBe(true)
  })

  it("carries the currency so a €1,250 wire never matches a $1,250 part", () => {
    const exp = expectedPartsFromPlans([{ token: "t1", payment_plan: PLAN }], new Set())
    expect(exp.every((e) => e.currency === "EUR")).toBe(true)
  })

  it("no plans → empty, which is exactly the pre-plan behaviour of the sweep", () => {
    expect(expectedPartsFromPlans([], new Set())).toEqual([])
  })
})
