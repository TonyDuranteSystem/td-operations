import { describe, it, expect } from "vitest"
import {
  feedText,
  extractFeedEmails,
  extractStripePaymentIntent,
  extractInvoiceReference,
} from "@/lib/finance/feed-signals"

/**
 * Fixtures below are the REAL production payloads from 2026-07-14 (Simple Holdings +
 * Tamás Fazekas) — the two payments the old matcher could not identify.
 */
const SIMPLE_HOLDINGS_CHARGE = {
  source: "stripe",
  sender_name: "Bilaal Rajan", // the CARDHOLDER — not the client
  memo: "email: shamim@simpleholdingsusa.com | visa ••••9765",
  sender_reference: null,
  raw_data: {
    payment_intent: "pi_3TsxouIHsqD3wMA90FWXL5Nd",
    metadata: {},
    billing_details: { email: "shamim@simpleholdingsusa.com", name: "Bilaal Rajan" },
  },
}

const FAZEKAS_CHARGE = {
  source: "stripe",
  sender_name: "Fazek", // TRUNCATED by Stripe — matches nothing
  memo: "email: fazekastamas28@gmail.com | mastercard ••••6367",
  sender_reference: null,
  raw_data: {
    payment_intent: "pi_3Tt2POIHsqD3wMA90ZnPxVCz",
    metadata: {},
    billing_details: { email: "fazekastamas28@gmail.com" },
  },
}

describe("extractStripePaymentIntent — the certain link", () => {
  it("reads the payment intent id from a stored charge", () => {
    expect(extractStripePaymentIntent(SIMPLE_HOLDINGS_CHARGE)).toBe("pi_3TsxouIHsqD3wMA90FWXL5Nd")
    expect(extractStripePaymentIntent(FAZEKAS_CHARGE)).toBe("pi_3Tt2POIHsqD3wMA90ZnPxVCz")
  })

  it("reads it from an EXPANDED payment intent object too", () => {
    expect(
      extractStripePaymentIntent({
        source: "stripe",
        raw_data: { payment_intent: { id: "pi_expanded_123", metadata: {} } },
      }),
    ).toBe("pi_expanded_123")
  })

  it("returns null for a wire — only Stripe carries a payment intent", () => {
    expect(
      extractStripePaymentIntent({ source: "relay", raw_data: { payment_intent: "pi_x" } }),
    ).toBeNull()
  })

  it("returns null when the payload has no payment intent", () => {
    expect(extractStripePaymentIntent({ source: "stripe", raw_data: {} })).toBeNull()
    expect(extractStripePaymentIntent({ source: "stripe", raw_data: null })).toBeNull()
  })

  it("ignores a value that is not a Stripe payment-intent id", () => {
    expect(
      extractStripePaymentIntent({ source: "stripe", raw_data: { payment_intent: "cs_session_id" } }),
    ).toBeNull()
  })
})

describe("extractFeedEmails — identity on a card payment", () => {
  it("finds the billing email even though the cardholder is someone else", () => {
    // This is the whole Simple Holdings case: the name is Bilaal, the money is the
    // company's, and only the email says so.
    expect(extractFeedEmails(SIMPLE_HOLDINGS_CHARGE)).toContain("shamim@simpleholdingsusa.com")
  })

  it("finds the payer's email when Stripe truncated their name to nonsense", () => {
    expect(extractFeedEmails(FAZEKAS_CHARGE)).toContain("fazekastamas28@gmail.com")
  })

  it("picks up an email written in a wire memo", () => {
    expect(
      extractFeedEmails({ source: "relay", memo: "payment from mario@example.com thanks" }),
    ).toContain("mario@example.com")
  })

  it("lowercases and de-duplicates", () => {
    const emails = extractFeedEmails({
      source: "stripe",
      memo: "email: Test@Example.com",
      raw_data: { billing_details: { email: "TEST@example.com" }, receipt_email: "test@example.com" },
    })
    expect(emails).toEqual(["test@example.com"])
  })

  it("returns an empty list when there is no email anywhere", () => {
    expect(extractFeedEmails({ source: "relay", sender_name: "ACME LLC", memo: "wire" })).toEqual([])
  })
})

describe("extractInvoiceReference — the number carried on the payment", () => {
  it("reads the invoice number from the EXPANDED payment intent metadata", () => {
    // Stripe does NOT copy Checkout Session metadata onto the charge — charge.metadata
    // is empty on every payment we have ever taken. The number lives on the intent.
    expect(
      extractInvoiceReference({
        source: "stripe",
        raw_data: {
          metadata: {},
          payment_intent: { id: "pi_1", metadata: { invoice_number: "INV-002404" } },
        },
      }),
    ).toBe("INV-002404")
  })

  it("still reads a charge-level invoice number when one is present", () => {
    expect(
      extractInvoiceReference({ source: "stripe", raw_data: { metadata: { invoice_number: "INV-001358" } } }),
    ).toBe("INV-001358")
  })

  it("returns null for the historical charges that carry no reference at all", () => {
    expect(extractInvoiceReference(SIMPLE_HOLDINGS_CHARGE)).toBeNull()
    expect(extractInvoiceReference(FAZEKAS_CHARGE)).toBeNull()
  })
})

describe("feedText", () => {
  it("includes the Stripe metadata name, not just the cardholder", () => {
    const text = feedText({
      source: "stripe",
      sender_name: "Bilaal Rajan",
      raw_data: { metadata: { Name: "Simple Holdings USA Inc" } },
    })
    expect(text).toContain("simple holdings usa inc")
    expect(text).toContain("bilaal rajan")
  })

  it("is lowercased", () => {
    expect(feedText({ source: "relay", sender_name: "ACME LLC" })).toBe("acme llc  ")
  })
})
