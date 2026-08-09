import { describe, it, expect } from "vitest"
import {
  buildOwnerLedgerRow,
  describeOwnerLedgerConcern,
  isClientInvoicePayment,
  isOwnerLedgerFeed,
  projectFeedsToOwnerLedger,
  OWNER_ACCOUNT_ID,
  type ProjectableFeed,
  type OpenInvoiceRef,
} from "@/lib/finance/owner-ledger-projection"
import type { ClientRosterEntry } from "@/lib/finance/client-payer-evidence"
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

  it("keeps it in Finance once the payer's name can be recognised", () => {
    expect(isClientInvoicePayment(HALF_PAYMENT, OWED_2500, { roster: CLIENT_ROSTER })).toBe(true)
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

  it("does not leak to a different bank or a different payer", () => {
    expect(isClientInvoicePayment({ ...UNNAMEABLE, source: "mercury" }, [], { taught: TAUGHT })).toBe(false)
    expect(isClientInvoicePayment({ ...UNNAMEABLE, sender_name: "Someone Else Entirely" }, [], { taught: TAUGHT })).toBe(false)
  })

  it("still refuses money leaving the account, taught or not", () => {
    expect(isClientInvoicePayment({ ...UNNAMEABLE, status: "outgoing" }, [], { taught: TAUGHT })).toBe(false)
  })
})
