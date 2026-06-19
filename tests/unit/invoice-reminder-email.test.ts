import { describe, it, expect } from "vitest"
import { buildReminderEmail } from "@/lib/billing/invoice-reminder"

const base = {
  clientName: "Lin Wang Chen",
  invoiceNumber: "INV-002346",
  amount: 36,
  currency: "USD",
  dueDate: "2026-06-10",
  isOverdue: true,
}

describe("buildReminderEmail", () => {
  it("English overdue: subject + greeting + header in EN", () => {
    const { subject, html } = buildReminderEmail({ ...base, language: "en" })
    expect(subject).toBe("Overdue: Invoice INV-002346 — Tony Durante LLC")
    expect(html).toContain("Dear Lin Wang Chen,")
    expect(html).toContain("Payment Overdue")
    expect(html).toContain("now past due")
    expect(html).toContain("$36.00")
  })

  it("Italian overdue: subject + greeting + header in IT", () => {
    const { subject, html } = buildReminderEmail({ ...base, language: "it" })
    expect(subject).toBe("Scaduta: Fattura INV-002346 — Tony Durante LLC")
    expect(html).toContain("Gentile Lin Wang Chen,")
    expect(html).toContain("Pagamento Scaduto")
    expect(html).toContain("scaduta")
    expect(html).toContain("Importo Dovuto")
  })

  it("defaults to English when language is null", () => {
    const { subject } = buildReminderEmail({ ...base, language: null })
    expect(subject).toContain("Overdue: Invoice")
  })

  it("non-overdue reminder uses the friendly wording (EN + IT)", () => {
    const en = buildReminderEmail({ ...base, language: "en", isOverdue: false })
    expect(en.subject).toBe("Reminder: Invoice INV-002346 — Tony Durante LLC")
    expect(en.html).toContain("Payment Reminder")
    expect(en.html).toContain("friendly reminder")

    const it = buildReminderEmail({ ...base, language: "it", isOverdue: false })
    expect(it.subject).toBe("Promemoria: Fattura INV-002346 — Tony Durante LLC")
    expect(it.html).toContain("Promemoria di Pagamento")
    expect(it.html).toContain("cortese promemoria")
  })

  it("uses € for EUR invoices", () => {
    const { html } = buildReminderEmail({ ...base, language: "en", currency: "EUR", amount: 2500 })
    expect(html).toContain("€2500.00")
  })

  it("omits the due-date row when dueDate is null", () => {
    const withDate = buildReminderEmail({ ...base, language: "en" })
    expect(withDate.html).toContain("Due Date")
    const noDate = buildReminderEmail({ ...base, language: "en", dueDate: null })
    expect(noDate.html).not.toContain("Due Date")
  })

  it("treats region variants like 'it-IT' as Italian", () => {
    const { subject } = buildReminderEmail({ ...base, language: "it-IT" })
    expect(subject).toContain("Scaduta: Fattura")
  })
})
