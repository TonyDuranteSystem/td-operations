/**
 * The summary shown on hover over an invoice number in the Bank Feed. The point is that the CLIENT is
 * always there — the description alone left Antonio unsure whose invoice it was. Delete the client
 * line and the first test fails; show the paid date for an unpaid invoice and the status tests fail.
 */
import { describe, it, expect } from "vitest"
import {
  summarizeInvoice,
  summaryInputFromPayerInvoice,
  summaryInputFromOpenInvoice,
  summaryInputFromMatchedPayment,
  type InvoiceSummaryInput,
} from "@/lib/finance/invoice-summary"

const base: InvoiceSummaryInput = {
  invoice_number: "INV-002323",
  party: "Simple Holdings USA Inc",
  description: "Affidavit document",
  installment: null,
  total: 50,
  balance: null,
  currency: "USD",
  paid: true,
  paid_date: "2026-06-16",
  status_label: null,
}
const value = (s: ReturnType<typeof summarizeInvoice>, label: string) => s.lines.find((l) => l.label === label)?.value

describe("summarizeInvoice", () => {
  it("names the client first, then what it is for, the amount and the status", () => {
    const s = summarizeInvoice(base)
    expect(s.title).toBe("INV-002323")
    expect(s.lines.map((l) => l.label)).toEqual(["Client", "For", "Amount", "Status"])
    expect(value(s, "Client")).toBe("Simple Holdings USA Inc")
    expect(value(s, "For")).toBe("Affidavit document")
    expect(value(s, "Amount")).toBe("$50.00")
    expect(value(s, "Status")).toBe("Paid Jun 16, 2026")
  })

  it("says plainly when there is no client, no number or no paid date", () => {
    const s = summarizeInvoice({ ...base, party: null, invoice_number: null, paid_date: null })
    expect(s.title).toBe("No invoice number")
    expect(value(s, "Client")).toBe("no client on this invoice")
    expect(value(s, "Status")).toBe("Paid")
  })

  it("shows what is still owed for an unpaid invoice, with its status word", () => {
    const s = summarizeInvoice({ ...base, paid: false, paid_date: null, balance: 300, total: 500, status_label: "Partial" })
    expect(value(s, "Status")).toBe("Partial — $300.00 still owed")
    expect(summarizeInvoice({ ...base, paid: false, paid_date: null, balance: null, status_label: null }).lines.find((l) => l.label === "Status")?.value).toBe("Not paid yet")
  })

  it("joins the description and the installment, and omits an empty 'For' line", () => {
    expect(value(summarizeInvoice({ ...base, installment: "2nd installment" }), "For")).toBe("Affidavit document — 2nd installment")
    expect(summarizeInvoice({ ...base, description: "  ", installment: null }).lines.some((l) => l.label === "For")).toBe(false)
  })

  it("flags an invoice another bank payment is already linked to", () => {
    expect(value(summarizeInvoice({ ...base, claimed_by_other: true }), "Note")).toMatch(/already linked/)
    expect(value(summarizeInvoice(base), "Note")).toBeUndefined()
  })

  it("uses the euro sign for a euro invoice and leaves the amount out when there is none", () => {
    expect(value(summarizeInvoice({ ...base, currency: "EUR", total: 2500 }), "Amount")).toBe("€2,500.00")
    expect(summarizeInvoice({ ...base, total: null }).lines.some((l) => l.label === "Amount")).toBe(false)
  })
})

describe("the three sources give the same summary", () => {
  it("an invoice from the 'who paid' list", () => {
    const input = summaryInputFromPayerInvoice({
      invoice_number: "INV-002121", party: "Simple Holdings USA Inc", description: "Public Notary", installment: null,
      total: 75, balance: null, currency: "USD", paid: true, paid_date: "2026-06-16", status_label: null, claimed_by_other: false,
    })
    const s = summarizeInvoice(input)
    expect(value(s, "Client")).toBe("Simple Holdings USA Inc")
    expect(value(s, "Status")).toBe("Paid Jun 16, 2026")
  })

  it("treats the list's '—' placeholder as no client", () => {
    const input = summaryInputFromPayerInvoice({
      invoice_number: null, party: "—", description: null, installment: null, total: 50, balance: null, currency: "USD",
      paid: true, paid_date: null, status_label: null, claimed_by_other: false,
    })
    expect(value(summarizeInvoice(input), "Client")).toBe("no client on this invoice")
  })

  it("an unpaid invoice the page holds: Partial shows amount_due, anything else shows the total", () => {
    const open = (over: Record<string, unknown>) => summaryInputFromOpenInvoice({
      invoice_number: "INV-1", description: "Consulting", total: "500", amount: 500, amount_due: "120", amount_currency: "USD", invoice_status: "Sent", ...over,
    }, "QA One LLC")
    expect(value(summarizeInvoice(open({})), "Status")).toBe("Sent — $500.00 still owed")
    expect(value(summarizeInvoice(open({ invoice_status: "Partial" })), "Status")).toBe("Partial — $120.00 still owed")
    expect(value(summarizeInvoice(open({})), "Client")).toBe("QA One LLC")
    expect(value(summarizeInvoice(open({ total: null })), "Amount")).toBe("$500.00")
  })

  it("an already-paid invoice from the paid search reads as paid, not as owed", () => {
    const s = summarizeInvoice(summaryInputFromOpenInvoice({
      invoice_number: "INV-2", description: "Notary", total: 75, amount: 75, amount_due: 0, amount_currency: "USD", invoice_status: "Paid", status: "Paid",
    }, "Simple Holdings USA Inc"))
    expect(value(s, "Status")).toBe("Paid")
    // Paid only through the coarse status column counts too.
    const quiet = summarizeInvoice(summaryInputFromOpenInvoice({
      invoice_number: "INV-3", description: null, total: 50, amount: 50, amount_due: null, amount_currency: "USD", invoice_status: null, status: "Paid",
    }, "X LLC"))
    expect(value(quiet, "Status")).toBe("Paid")
  })

  it("the invoice a matched transaction points at", () => {
    const paid = summaryInputFromMatchedPayment({
      invoice_number: "INV-002323", description: "Affidavit", total: 50, amount_paid: 50, invoice_status: "Paid", accounts: { company_name: "Simple Holdings USA Inc" },
    }, "USD")
    expect(value(summarizeInvoice(paid), "Client")).toBe("Simple Holdings USA Inc")
    expect(value(summarizeInvoice(paid), "Status")).toBe("Paid")

    const part = summaryInputFromMatchedPayment({
      invoice_number: "INV-9", description: null, total: 200, amount_paid: 75, invoice_status: "Partial", accounts: null,
    }, "USD")
    expect(value(summarizeInvoice(part), "Status")).toBe("Partial — $125.00 still owed")
    expect(value(summarizeInvoice(part), "Client")).toBe("no client on this invoice")

    // An invoice written to a PERSON (no company) names the person — the real INV-002713 case.
    const person = summaryInputFromMatchedPayment({
      invoice_number: "INV-002713", description: "Paid Strategy Call", total: 397, amount_paid: 397, invoice_status: "Paid",
      accounts: null, contacts: { full_name: "Nicola Catacchio" },
    }, "EUR")
    expect(value(summarizeInvoice(person), "Client")).toBe("Nicola Catacchio")
    // The company wins when both exist; the embed may arrive as an array.
    const both = summaryInputFromMatchedPayment({
      invoice_number: "INV-1", description: null, total: 10, amount_paid: 10, invoice_status: "Paid",
      accounts: { company_name: "Acme LLC" }, contacts: [{ full_name: "Mario Rossi" }],
    }, "USD")
    expect(value(summarizeInvoice(both), "Client")).toBe("Acme LLC")
  })
})
