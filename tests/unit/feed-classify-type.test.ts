import { describe, it, expect } from "vitest"
import { classifyFeedType } from "@/lib/finance/feed-signals"

/**
 * Fixtures are faithful subsets of REAL production rows (mirrored into sandbox
 * 2026-07-26). They deliberately include the two Plaid traps: a genuine client
 * payment Plaid tagged TRANSFER_IN, and a Stripe payout Plaid tagged INCOME.
 */
describe("classifyFeedType", () => {
  it("Mercury referral reward → bank_reward (counterparty is the bank itself)", () => {
    const r = classifyFeedType({
      source: "mercury_api",
      sender_name: "Mercury",
      memo: "Mercury — Cash bonus for referring ATCOACHING LLC.",
      raw_data: { kind: "other", counterpartyName: "Mercury", categoryData: { name: "Transfer" } },
    })
    expect(r.type).toBe("bank_reward")
    expect(r.basis).toBe("counterparty_exact")
  })

  it("a client literally named like the bank is NOT a reward", () => {
    const r = classifyFeedType({
      source: "mercury_api",
      sender_name: "Mercury Ventures LLC",
      raw_data: { counterpartyName: "Mercury Ventures LLC", categoryData: { name: "Revenue" } },
    })
    expect(r.type).toBe("client_payment")
  })

  it("Relay Stripe payout → stripe_payout by signature (even though Plaid tagged it INCOME)", () => {
    const r = classifyFeedType({
      source: "relay",
      sender_name: "STRIPE - TRANSFER",
      memo: "STRIPE - TRANSFER",
      raw_data: {
        category: ["Transfer", "Credit"],
        personal_finance_category: { primary: "INCOME", detailed: "INCOME_OTHER", confidence_level: "LOW" },
      },
    })
    expect(r.type).toBe("stripe_payout")
    expect(r.basis).toBe("name")
  })

  it("Mercury (Plaid) Stripe payout → stripe_payout by signature (semicolon form)", () => {
    const r = classifyFeedType({
      source: "mercury",
      sender_name: "STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE",
      raw_data: { personal_finance_category: { detailed: "INCOME_CONTRACTOR", confidence_level: "LOW" } },
    })
    expect(r.type).toBe("stripe_payout")
  })

  it("a client card charge (source=stripe) is NOT a payout", () => {
    const r = classifyFeedType({
      source: "stripe",
      sender_name: "Bilaal Rajan",
      memo: "email: rajan.aman@gmail.com | visa ••••9765",
      raw_data: { object: "charge", payment_intent: "pi_3T5A2OIHsqD3wMA91AaRi1um", billing_details: { name: "Bilaal Rajan" } },
    })
    expect(r.type).toBe("client_payment")
  })

  it("TRAP: a real client payment Plaid mis-tagged TRANSFER_IN_ACCOUNT_TRANSFER stays a client payment", () => {
    // Measured 2026-07-26: Plaid tagged ~17 real client payments ACCOUNT_TRANSFER. The
    // per-row classifier must NOT treat that category as an internal transfer, or client
    // money would be hidden from invoice matching.
    const r = classifyFeedType({
      source: "mercury",
      sender_name: "From Next To Prime LLC via mercury.com",
      raw_data: { personal_finance_category: { detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", confidence_level: "LOW" } },
    })
    expect(r.type).toBe("client_payment")
  })

  it("an own outgoing transfer is not classified internal here (handled by its outgoing direction)", () => {
    const r = classifyFeedType({
      source: "relay",
      sender_name: "Tony Durante LLC SC - Relay Sent By Antonio Durante",
      raw_data: { personal_finance_category: { detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", confidence_level: "LOW" } },
    })
    expect(r.type).toBe("client_payment")
  })

  it("TRAP: real client WISE payment Plaid mis-tagged TRANSFER_IN stays a client payment", () => {
    const r = classifyFeedType({
      source: "relay",
      sender_name: "WISE US INC. - INV-001389 -WR",
      raw_data: {
        personal_finance_category: { detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", confidence_level: "LOW" },
      },
    })
    expect(r.type).toBe("client_payment")
  })

  it("Airwallex client payment → client_payment", () => {
    const r = classifyFeedType({
      source: "airwallex_api",
      sender_name: "2L CONSULTING LLC",
      raw_data: { type: "BANK_TRANSFER", payer_name: "2L CONSULTING LLC" },
    })
    expect(r.type).toBe("client_payment")
  })

  it("Mercury client consulting payment → client_payment", () => {
    const r = classifyFeedType({
      source: "mercury_api",
      sender_name: "KS MEDIA CONSULT",
      raw_data: { counterpartyName: "KS MEDIA CONSULT", categoryData: { name: "Revenue" } },
    })
    expect(r.type).toBe("client_payment")
  })

  it("'Pinstripe' + 'wire transfer' does NOT false-match the Stripe signature", () => {
    const r = classifyFeedType({
      source: "relay",
      sender_name: "Pinstripe Media LLC",
      memo: "incoming wire transfer",
      raw_data: {},
    })
    expect(r.type).toBe("client_payment")
  })

  it("empty/missing raw_data defaults safely to client_payment", () => {
    expect(classifyFeedType({ source: "relay", sender_name: "Some Client LLC" }).type).toBe("client_payment")
    expect(classifyFeedType({}).type).toBe("client_payment")
  })
})
