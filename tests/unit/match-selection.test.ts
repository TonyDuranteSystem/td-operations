/**
 * What the ticks in the Match popup mean. The browser's paid/unpaid labels are a stale snapshot,
 * so the server decides from current status. Delete the mixed refusal and the "mixed" tests fail;
 * trust the browser's labels and the stale-selection test fails.
 */
import { describe, it, expect } from "vitest"
import { planMatchSelection, recordOnlyLinkNote, claimedInvoicesError, type SelectedInvoiceRow } from "@/lib/finance/match-selection"

const row = (id: string, over: Partial<SelectedInvoiceRow> = {}): SelectedInvoiceRow => ({
  id,
  invoice_number: `INV-${id}`,
  invoice_status: "Sent",
  status: "Pending",
  ...over,
})
const paid = (id: string) => row(id, { invoice_status: "Paid", status: "Paid" })

describe("planMatchSelection", () => {
  it("passes an all-unpaid selection to the existing match untouched, in the order picked", () => {
    expect(planMatchSelection(["b", "a"], [row("a"), row("b")])).toEqual({ kind: "open", openIds: ["b", "a"] })
  })

  it("links an all-paid selection for the record", () => {
    expect(planMatchSelection(["1", "2"], [paid("1"), paid("2")])).toEqual({ kind: "paid", paidIds: ["1", "2"] })
  })

  it("treats an invoice paid only through the coarse status column as paid", () => {
    const quiet = row("q", { invoice_status: null, status: "Paid" })
    expect(planMatchSelection(["q", "1"], [quiet, paid("1")])).toEqual({ kind: "paid", paidIds: ["q", "1"] })
  })

  it("refuses a mix, names which is which, and says what to do instead", () => {
    const plan = planMatchSelection(["1", "2", "3"], [paid("1"), paid("2"), row("3")])
    expect(plan.kind).toBe("refused")
    if (plan.kind !== "refused") return
    expect(plan.error).toContain("INV-1, INV-2 are already paid")
    expect(plan.error).toContain("INV-3 is not")
    expect(plan.error).toMatch(/only the already-paid invoices/)
    expect(plan.error).toMatch(/only the unpaid ones/)
  })

  it("decides from CURRENT status, not the page's snapshot: an invoice that was open when the page loaded and is paid now makes the selection mixed", () => {
    // The person ticked A and B as unpaid; since then A was marked paid.
    const plan = planMatchSelection(["a", "b"], [paid("a"), row("b")])
    expect(plan.kind).toBe("refused")
  })

  it("refuses a voided or cancelled invoice ticked next to a paid one, instead of skipping it quietly", () => {
    const plan = planMatchSelection(["1", "v"], [paid("1"), row("v", { invoice_status: "Voided", status: "Cancelled" })])
    expect(plan.kind).toBe("refused")
  })

  it("refuses an empty selection and an invoice that no longer exists", () => {
    expect(planMatchSelection([], [])).toMatchObject({ kind: "refused" })
    expect(planMatchSelection(["gone"], [row("a")])).toMatchObject({ kind: "refused", error: expect.stringContaining("could not be found") })
  })

  it("ignores duplicates and blanks in the ids", () => {
    expect(planMatchSelection(["1", "1", ""], [paid("1")])).toEqual({ kind: "paid", paidIds: ["1"] })
  })
})

describe("recordOnlyLinkNote", () => {
  it("says what the payment was", () => {
    expect(recordOnlyLinkNote({ amount: 125, currency: "USD", sender_name: " Bilaal Rajan ", transaction_date: "2026-06-16" }))
      .toBe("Linked from the Bank Feed: payment of 125.00 USD from Bilaal Rajan on 2026-06-16.")
  })

  it("copes with missing pieces", () => {
    expect(recordOnlyLinkNote({})).toBe("Linked from the Bank Feed: payment of 0.00 USD.")
    expect(recordOnlyLinkNote({ amount: "52.5", currency: "EUR" })).toBe("Linked from the Bank Feed: payment of 52.50 EUR.")
  })
})

describe("claimedInvoicesError", () => {
  const rows = [{ id: "a", invoice_number: "INV-1" }, { id: "b", invoice_number: "INV-2" }, { id: "c", invoice_number: null }]

  it("is null when no invoice is taken", () => {
    expect(claimedInvoicesError(rows, new Set())).toBeNull()
    expect(claimedInvoicesError(rows, new Set(["zzz"]))).toBeNull()
  })

  it("names the taken invoices and says why", () => {
    expect(claimedInvoicesError(rows, new Set(["a"]))).toContain("INV-1 is already linked to another bank payment")
    const two = claimedInvoicesError(rows, new Set(["a", "c"]))!
    expect(two).toContain("INV-1, An invoice are already linked")
    expect(two).toMatch(/count(ed)? (it )?twice|twice/)
  })
})
