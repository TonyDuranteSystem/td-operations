import { describe, it, expect } from "vitest"
import {
  buildInvoiceEmail,
  buildPayUrl,
  buildPortalInvoiceUrl,
  buildPortalReceiptsUrl,
  generatePayToken,
} from "@/lib/email/invoice-email"

const baseInput = {
  clientName: "Diendei LLC",
  invoiceNumber: "INV-002049",
  issueDate: "2026-04-22",
  dueDate: "2026-05-22",
  total: 600,
  currencySymbol: "$",
  currency: "USD",
  payToken: "test-pay-token-abc",
  bankDetails: {
    label: "Relay — USD",
    accountHolder: "Tony Durante LLC",
    bankName: "Relay Financial",
    accountNumber: "200000306770",
    routingNumber: "064209588",
  },
} as const

describe("generatePayToken", () => {
  it("returns a URL-safe token of sufficient entropy", () => {
    const tok = generatePayToken()
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/) // base64url
    expect(tok.length).toBeGreaterThanOrEqual(43) // 32 bytes base64url ≈ 43 chars
  })

  it("returns different tokens on successive calls", () => {
    const a = generatePayToken()
    const b = generatePayToken()
    expect(a).not.toBe(b)
  })
})

describe("URL builders", () => {
  it("buildPayUrl uses APP_BASE_URL and the token", () => {
    const u = buildPayUrl("abc123")
    expect(u.endsWith("/pay/abc123")).toBe(true)
  })

  it("buildPortalInvoiceUrl embeds the payment ID", () => {
    const u = buildPortalInvoiceUrl("payment-uuid-xyz")
    expect(u).toContain("/portal/invoices")
    expect(u).toContain("payment-uuid-xyz")
  })

  it("buildPortalReceiptsUrl points at the paid view", () => {
    const u = buildPortalReceiptsUrl()
    expect(u).toContain("/portal/invoices")
    expect(u).toContain("paid")
  })
})

describe("buildInvoiceEmail — subjects", () => {
  it("initial invoice subject", () => {
    const { subject } = buildInvoiceEmail({ ...baseInput, purpose: "initial", audience: "portal" })
    expect(subject).toBe("Invoice INV-002049 from Tony Durante LLC")
  })

  it("reminder subject includes 'Reminder'", () => {
    const { subject } = buildInvoiceEmail({ ...baseInput, purpose: "reminder", audience: "portal" })
    expect(subject).toContain("Reminder")
    expect(subject).toContain("INV-002049")
  })

  it("credit note subject uses 'Credit Note'", () => {
    const { subject } = buildInvoiceEmail({ ...baseInput, purpose: "credit", audience: "portal" })
    expect(subject).toBe("Credit Note INV-002049 from Tony Durante LLC")
  })

  it("receipt subject uses 'Payment received'", () => {
    const { subject } = buildInvoiceEmail({ ...baseInput, purpose: "receipt", audience: "portal" })
    expect(subject).toBe("Payment received for Invoice INV-002049")
  })
})

describe("buildInvoiceEmail — portal audience (Client with active portal)", () => {
  it("initial invoice shows portal CTA, does NOT expose payToken or bank details", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "initial", audience: "portal" })
    expect(html).toContain("Log in to your portal")
    expect(html).not.toContain("Pay with Card")
    expect(html).not.toContain(baseInput.payToken)
    expect(html).not.toContain(baseInput.bankDetails.accountNumber)
    expect(html).not.toContain(baseInput.bankDetails.routingNumber)
  })

  it("reminder also uses portal CTA with no bank details", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "reminder", audience: "portal" })
    expect(html).toContain("Log in to your portal")
    expect(html).not.toContain(baseInput.bankDetails.accountNumber)
  })

  it("receipt links to the paid-invoices archive in the portal", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "receipt", audience: "portal" })
    expect(html).toContain("paid")
    expect(html).toContain("Thank you")
  })

  it("credit note does NOT include a payment CTA", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "credit", audience: "portal" })
    expect(html).not.toContain("Pay with Card")
    expect(html).not.toContain("Log in to your portal to review")
  })
})

describe("buildInvoiceEmail — no_portal audience (One-Time customers)", () => {
  it("initial invoice includes Pay with Card button AND bank details", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "initial", audience: "no_portal" })
    expect(html).toContain("Pay with Card")
    expect(html).toContain(`/pay/${baseInput.payToken}`)
    expect(html).toContain(baseInput.bankDetails.accountNumber)
    expect(html).toContain(baseInput.bankDetails.routingNumber)
    expect(html).not.toContain("Log in to your portal")
  })

  it("reminder includes the same Pay with Card + bank details", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "reminder", audience: "no_portal" })
    expect(html).toContain("Pay with Card")
    expect(html).toContain(baseInput.bankDetails.accountNumber)
  })

  it("receipt does NOT include a Pay button (already paid)", () => {
    const { html } = buildInvoiceEmail({ ...baseInput, purpose: "receipt", audience: "no_portal" })
    expect(html).not.toContain("Pay with Card")
    expect(html).toContain("Thank you")
  })

  it("gracefully handles missing payToken (bank-only fallback)", () => {
    const { html } = buildInvoiceEmail({
      ...baseInput,
      payToken: null,
      purpose: "initial",
      audience: "no_portal",
    })
    expect(html).not.toContain("Pay with Card")
    expect(html).toContain(baseInput.bankDetails.accountNumber)
  })

  it("gracefully handles missing bankDetails (CTA-only fallback)", () => {
    const { html } = buildInvoiceEmail({
      ...baseInput,
      bankDetails: null,
      purpose: "initial",
      audience: "no_portal",
    })
    expect(html).toContain("Pay with Card")
    expect(html).not.toContain("Bank Transfer — ")
  })
})

describe("buildInvoiceEmail — shared structure invariants", () => {
  it("every variant renders the TD header + footer", () => {
    const variants: Array<{ purpose: "initial" | "reminder" | "credit" | "receipt"; audience: "portal" | "no_portal" }> = [
      { purpose: "initial", audience: "portal" },
      { purpose: "initial", audience: "no_portal" },
      { purpose: "reminder", audience: "portal" },
      { purpose: "reminder", audience: "no_portal" },
      { purpose: "credit", audience: "portal" },
      { purpose: "credit", audience: "no_portal" },
      { purpose: "receipt", audience: "portal" },
      { purpose: "receipt", audience: "no_portal" },
    ]
    for (const v of variants) {
      const { html } = buildInvoiceEmail({ ...baseInput, ...v })
      expect(html).toContain("Tony Durante LLC")
      expect(html).toContain("1111 Lincoln Road")
      expect(html).toContain(baseInput.invoiceNumber)
    }
  })

  it("escapes HTML in the message field", () => {
    const { html } = buildInvoiceEmail({
      ...baseInput,
      message: "<script>alert('x')</script> & <b>bold</b>",
      purpose: "initial",
      audience: "portal",
    })
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&amp;")
  })

  it("renders due date only for initial + reminder purposes", () => {
    const initial = buildInvoiceEmail({ ...baseInput, purpose: "initial", audience: "portal" }).html
    const reminder = buildInvoiceEmail({ ...baseInput, purpose: "reminder", audience: "portal" }).html
    const receipt = buildInvoiceEmail({ ...baseInput, purpose: "receipt", audience: "portal" }).html
    const credit = buildInvoiceEmail({ ...baseInput, purpose: "credit", audience: "portal" }).html
    expect(initial).toContain(baseInput.dueDate)
    expect(reminder).toContain(baseInput.dueDate)
    expect(receipt).not.toContain("Due Date")
    expect(credit).not.toContain("Due Date")
  })
})
