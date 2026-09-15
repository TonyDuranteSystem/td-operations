import { describe, it, expect } from "vitest"
import { isMatchableInvoice, isTerminalInvoice, isPaidInvoice, terminalReason, wasFullyPaid } from "@/lib/finance/invoice-matchability"

/**
 * These cases are taken from REAL production rows (2026-07-14). The old predicate read
 * `invoice_status` alone; every failure below was a live money bug.
 */
describe("isMatchableInvoice — the two-column terminal rule", () => {
  it("keeps Draft matchable — invoice created at contract signing, payment can arrive first", () => {
    expect(isMatchableInvoice({ invoice_status: "Draft", status: "Pending" })).toBe(true)
  })

  it("keeps Sent matchable", () => {
    expect(isMatchableInvoice({ invoice_status: "Sent", status: "Pending" })).toBe(true)
  })

  it("keeps Overdue matchable", () => {
    expect(isMatchableInvoice({ invoice_status: "Overdue", status: "Overdue" })).toBe(true)
  })

  it("keeps Partial matchable — the remaining balance is still owed", () => {
    expect(isMatchableInvoice({ invoice_status: "Partial", status: "Pending" })).toBe(true)
  })

  it("excludes Paid", () => {
    expect(isMatchableInvoice({ invoice_status: "Paid", status: "Paid" })).toBe(false)
  })

  it("excludes Voided", () => {
    expect(isMatchableInvoice({ invoice_status: "Voided", status: "Waived" })).toBe(false)
  })

  it("excludes Cancelled", () => {
    expect(isMatchableInvoice({ invoice_status: "Cancelled", status: "Cancelled" })).toBe(false)
  })

  it("excludes Credit", () => {
    expect(isMatchableInvoice({ invoice_status: "Credit", status: "Paid" })).toBe(false)
  })

  // THE LANDMINE: 48 production invoices are Paid via `status` with a NULL invoice_status.
  // Reading invoice_status alone left them as live auto-match targets — a new payment of
  // the right amount could be credited to an invoice paid months ago.
  it("excludes an invoice that is Paid via `status` even when invoice_status is NULL", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Paid" })).toBe(false)
  })

  it("excludes an invoice Paid via `status` when invoice_status still says Sent (half-closed row)", () => {
    expect(isMatchableInvoice({ invoice_status: "Sent", status: "Paid" })).toBe(false)
  })

  // THE REGRESSION THIS RULE ALMOST CAUSED. Three live production invoices carry
  // status='Cancelled' next to a real, open invoice_status. INV-002084 (Fiscalot) has
  // been part-paid and STILL OWES $500. Treating `status` as an absolute veto made that
  // $500 impossible to receive: the matcher ignored the invoice, staff could not even
  // select it, and a manual attempt reported success while moving no money.
  // `invoice_status` is the operational column — it wins when it is present.
  it("KEEPS a part-paid invoice matchable when status says Cancelled but invoice_status says Partial", () => {
    expect(isMatchableInvoice({ invoice_status: "Partial", status: "Cancelled" })).toBe(true)
  })

  it("KEEPS an Overdue invoice matchable even when status says Cancelled", () => {
    expect(isMatchableInvoice({ invoice_status: "Overdue", status: "Cancelled" })).toBe(true)
  })

  // But money already RECEIVED always wins, whatever the invoice document says.
  it("excludes an invoice Paid via `status` even when invoice_status looks open", () => {
    expect(isMatchableInvoice({ invoice_status: "Overdue", status: "Paid" })).toBe(false)
  })

  // THE OTHER SIDE OF THE TRAP: a blanket "exclude NULL invoice_status" rule would have
  // made this real $1,250 open receivable permanently unmatchable AND hidden it from the
  // manual match list. NULL falls back to `status`, which says Overdue → still owed.
  it("KEEPS a genuine open receivable that has no invoice_status but status=Overdue", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Overdue" })).toBe(true)
  })

  it("excludes Refunded — the money went back to the client", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Refunded" })).toBe(false)
  })

  it("excludes Not Invoiced placeholder rows — there is no invoice to settle", () => {
    expect(isMatchableInvoice({ invoice_status: null, status: "Not Invoiced" })).toBe(false)
  })

  it("treats an empty-string invoice_status as absent and falls back to status", () => {
    expect(isMatchableInvoice({ invoice_status: "  ", status: "Paid" })).toBe(false)
    expect(isMatchableInvoice({ invoice_status: "  ", status: "Overdue" })).toBe(true)
  })

  it("isTerminalInvoice is the exact inverse of isMatchableInvoice", () => {
    const rows = [
      { invoice_status: "Paid", status: "Paid" },
      { invoice_status: null, status: "Overdue" },
      { invoice_status: "Draft", status: "Pending" },
    ]
    for (const r of rows) {
      expect(isTerminalInvoice(r)).toBe(!isMatchableInvoice(r))
    }
  })
})

describe("isPaidInvoice — who may be audit-linked", () => {
  // Linking a payment to a closed invoice is legitimate in exactly ONE case: the money
  // was already received through another channel (a card charge tied to the invoice its
  // own webhook settled, or a human doing the same thing by hand). Linking money to a
  // CANCELLED invoice is never legitimate — the manual path must reject it loudly instead
  // of recording a cheerful "linked" with nothing applied, which is the silent-success
  // failure this work exists to kill.
  it("is true for an invoice already paid (either column)", () => {
    expect(isPaidInvoice({ invoice_status: "Paid", status: "Paid" })).toBe(true)
    expect(isPaidInvoice({ invoice_status: null, status: "Paid" })).toBe(true)
  })

  // FIXED 2026-09-15: a live-shaped case (the document was never updated to Paid, but
  // the coarse ledger status already is) must still be audit-linkable — the OLD
  // definition's flat `invoice_status === "Paid" || status === "Paid"` OR read this as
  // FALSE, since "Overdue" !== "Paid" short-circuited the check before `status` was ever
  // consulted, reproducing the exact "no way to audit-link my own already-paid invoice"
  // dead-end this predicate exists to prevent. The fixed version defers to
  // isTerminalInvoice's own precedence: an open-looking invoice_status falls back to
  // the coarse status instead of vetoing it.
  it("is true when invoice_status is stale (still Overdue/Sent) but the ledger status already reads Paid", () => {
    expect(isPaidInvoice({ invoice_status: "Overdue", status: "Paid" })).toBe(true)
    expect(isPaidInvoice({ invoice_status: "Sent", status: "Paid" })).toBe(true)
  })

  it("is FALSE for a cancelled or voided invoice — never audit-link money to it", () => {
    expect(isPaidInvoice({ invoice_status: "Cancelled", status: "Cancelled" })).toBe(false)
    expect(isPaidInvoice({ invoice_status: "Voided", status: "Waived" })).toBe(false)
  })

  // FIXED 2026-09-15 (bug-hunter + senior-engineer + ai-architect, independently — a
  // credit note is money owed BACK to the client, never money TD received; confirmed
  // against 15 real production Credit rows, every one a negative-amount referral
  // reward, overpayment refund, or paid-call credit, none of them TD receiving money).
  // A prior version of this test asserted `true` here, with a comment claiming this was
  // a deliberate, already-reviewed decision (dev job ef5da377) — checked directly
  // against that job's own record: it decided a DIFFERENT question (this predicate must
  // never gate the "already Paid" correction prompt, see wasFullyPaid below) and never
  // actually audited whether "Paid" was correct for the audit-link case. It wasn't —
  // the old, flat `status === "Paid"` OR read every credit note as already-paid money,
  // which would have silently audit-linked a real transaction to one as "money already
  // received," exactly backwards.
  it("is FALSE for a credit note, even though its coarse status also reads Paid", () => {
    expect(isPaidInvoice({ invoice_status: "Credit", status: "Paid" })).toBe(false)
  })
})

describe("wasFullyPaid — the already-Paid correction-prompt gate", () => {
  it("is true for an ordinary fully-paid invoice", () => {
    expect(wasFullyPaid({ invoice_status: "Paid", status: "Paid" })).toBe(true)
  })

  it("is true for a legacy row Paid via `status` with no invoice_status", () => {
    expect(wasFullyPaid({ invoice_status: null, status: "Paid" })).toBe(true)
  })

  // THE case this function exists to get right where isPaidInvoice doesn't:
  // a credit note's invoice_status is always 'Credit', never null and never
  // 'Paid' — so it must never match here, regardless of what the coarse
  // `status` column says.
  it("is FALSE for a credit note, even though its coarse status is Paid", () => {
    expect(wasFullyPaid({ invoice_status: "Credit", status: "Paid" })).toBe(false)
  })

  // invoice_status wins when present — a half-closed row (Sent but somehow
  // status=Paid) is NOT treated as fully paid by this gate. Matches the
  // already-shipped, already-correct behavior this function was extracted
  // from verbatim.
  it("is FALSE when invoice_status is present and says Sent, even if status says Paid", () => {
    expect(wasFullyPaid({ invoice_status: "Sent", status: "Paid" })).toBe(false)
  })

  it("is FALSE for a cancelled invoice", () => {
    expect(wasFullyPaid({ invoice_status: "Cancelled", status: "Cancelled" })).toBe(false)
  })

  it("is FALSE for an ordinary open Draft invoice", () => {
    expect(wasFullyPaid({ invoice_status: "Draft", status: "Pending" })).toBe(false)
  })

  it("treats an empty-string invoice_status as absent and falls back to status", () => {
    expect(wasFullyPaid({ invoice_status: "  ", status: "Paid" })).toBe(true)
    expect(wasFullyPaid({ invoice_status: "  ", status: "Overdue" })).toBe(false)
  })
})

describe("terminalReason — the message staff sees when a match is refused", () => {
  it("names the invoice_status when that is what closed it", () => {
    expect(terminalReason({ invoice_status: "Paid", status: "Paid" })).toBe("Invoice is already Paid")
  })

  it("explains an administrative close when there is no invoice_status", () => {
    expect(terminalReason({ invoice_status: null, status: "Cancelled" })).toBe(
      "Invoice is Cancelled — nothing is owed on it",
    )
  })

  it("returns null for an invoice that is still open", () => {
    expect(terminalReason({ invoice_status: "Sent", status: "Pending" })).toBeNull()
  })

  it("returns null for the part-paid, status-Cancelled invoice that is still owed", () => {
    expect(terminalReason({ invoice_status: "Partial", status: "Cancelled" })).toBeNull()
  })
})
