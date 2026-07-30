/**
 * The guard that stops one client's money settling another client's invoice.
 *
 * Every test here is a MUTATION TEST for a specific line of the guard: delete the tie check
 * and the "incident replay" cases fail; delete the deterministic comparator and the ordering
 * cases fail; delete the duplicate-row exemption and the orphan case fails. Before this
 * module existed NOTHING in the suite asserted candidate selection at all — the matcher chose
 * a client to credit inside an un-exported async function, and the choice came down to
 * physical database row order.
 */

import { describe, it, expect } from "vitest"
import {
  selectBestCandidate,
  compareCandidates,
  type ScoredCandidate,
} from "@/lib/finance/candidate-selection"

function c(over: Partial<ScoredCandidate> & { id: string }): ScoredCandidate {
  return {
    invoiceNumber: `INV-${over.id}`,
    confidence: "exact",
    score: 95,
    accountId: `acct-${over.id}`,
    contactId: null,
    clientName: `Client ${over.id}`,
    ...over,
  }
}

describe("selectBestCandidate — the 2026-07-22 incident", () => {
  // THE REAL CASE. A $1,000 wire from "LC Marketing Consulting"; both companies held an open
  // $1,000 invoice and both scored 95 on the shared word "marketing". The old code took the
  // head of the sorted list and settled it.
  const aces = c({ id: "aces", score: 95, invoiceNumber: "INV-002151", accountId: "acct-aces" })
  const lc = c({ id: "lc", score: 95, invoiceNumber: "INV-002194", accountId: "acct-lc" })

  it("refuses to choose between two different clients on the same score", () => {
    const sel = selectBestCandidate([aces, lc])
    expect(sel.contested).toBe(true)
    expect(sel.reason).toBe("tied_across_clients")
    expect(sel.tied.map((t) => t.id).sort()).toEqual(["aces", "lc"])
  })

  it("is contested regardless of which order the database returned the rows in", () => {
    // The candidate query has no ORDER BY. If the guard depended on input order it would
    // pass one way and fail the other — which is exactly how the wrong client was picked.
    const forward = selectBestCandidate([aces, lc])
    const reverse = selectBestCandidate([lc, aces])
    expect(forward.contested).toBe(true)
    expect(reverse.contested).toBe(true)
    expect(forward.best?.id).toBe(reverse.best?.id)
  })
})

describe("selectBestCandidate — ties inside one client", () => {
  it("refuses a genuine two-same-priced-invoices tie for one client", () => {
    // Simple Holdings really holds two $50 notary invoices. Only the invoice number can
    // separate them; guessing is a coin flip with a client's money.
    const a = c({ id: "a", score: 95, accountId: "acct-x", invoiceNumber: "INV-1" })
    const b = c({ id: "b", score: 95, accountId: "acct-x", invoiceNumber: "INV-2" })
    const sel = selectBestCandidate([a, b])
    expect(sel.contested).toBe(true)
    expect(sel.reason).toBe("tied_same_client")
  })

  it("REFUSES even the duplicate-row case, and pins the numbered row as the suggestion", () => {
    // This test asserted the opposite until 2026-07-29. The exemption (same client + exactly
    // one numbered row ⇒ settle the numbered one) was removed after the Bug-Hunter showed an
    // un-numbered row is NOT reliably an orphan: production holds real matchable obligations
    // with no invoice number and no invoice_status (invoice-matchability.ts cites a $1,250
    // "First Installment 2026", Overdue, unnumbered). Paired with the same client's numbered
    // second installment, the exemption settled the wire onto the WRONG installment, fired the
    // installment handler for the wrong one, and left the invoice the client actually paid open
    // and being chased. A tie is a tie; the numbered row is only the starting suggestion.
    const real = c({ id: "real", score: 95, accountId: "acct-x", invoiceNumber: "INV-002200" })
    const orphan = c({ id: "orphan", score: 95, accountId: "acct-x", invoiceNumber: null })
    const sel = selectBestCandidate([orphan, real])
    expect(sel.contested).toBe(true)
    expect(sel.reason).toBe("tied_same_client")
    expect(sel.best?.id).toBe("real") // pinned first for the reviewer, NOT settled
    expect(sel.tied.map((t) => t.id).sort()).toEqual(["orphan", "real"])
  })

  it("still refuses when BOTH duplicate rows carry invoice numbers", () => {
    const a = c({ id: "a", score: 95, accountId: "acct-x", invoiceNumber: "INV-1" })
    const b = c({ id: "b", score: 95, accountId: "acct-x", invoiceNumber: "INV-2" })
    expect(selectBestCandidate([a, b]).contested).toBe(true)
  })

  it("treats contact-scoped invoices as belonging to their contact", () => {
    const a = c({ id: "a", score: 95, accountId: null, contactId: "ct-1", invoiceNumber: "INV-1" })
    const b = c({ id: "b", score: 95, accountId: null, contactId: "ct-2", invoiceNumber: "INV-2" })
    expect(selectBestCandidate([a, b]).reason).toBe("tied_across_clients")
  })
})

describe("selectBestCandidate — automation that must keep working", () => {
  it("the invoice-reference tier still wins outright through a tie below it", () => {
    // The reference tier scores 100 + a 20 boost. A payment that names its invoice must
    // still self-reconcile even when two other invoices tie beneath it — that is the whole
    // point of putting the number on the payment.
    const referenced = c({ id: "ref", score: 120, accountId: "acct-ref" })
    const tieA = c({ id: "a", score: 95, accountId: "acct-a" })
    const tieB = c({ id: "b", score: 95, accountId: "acct-b" })
    const sel = selectBestCandidate([tieA, referenced, tieB])
    expect(sel.contested).toBe(false)
    expect(sel.best?.id).toBe("ref")
  })

  it("a single clear winner is not contested", () => {
    const best = c({ id: "best", score: 95 })
    const worse = c({ id: "worse", score: 70, confidence: "high" })
    const sel = selectBestCandidate([best, worse])
    expect(sel.contested).toBe(false)
    expect(sel.best?.id).toBe("best")
    expect(sel.tied).toEqual([])
  })

  it("no candidates at all", () => {
    expect(selectBestCandidate([])).toEqual({ best: null, contested: false, tied: [] })
  })
})

describe("compareCandidates — deterministic ordering", () => {
  it("orders by score first", () => {
    expect(compareCandidates(c({ id: "a", score: 70 }), c({ id: "b", score: 95 }))).toBeGreaterThan(0)
  })

  it("prefers a numbered row over an un-numbered one at equal score", () => {
    const numbered = c({ id: "b", score: 95, invoiceNumber: "INV-1" })
    const orphan = c({ id: "a", score: 95, invoiceNumber: null })
    expect(compareCandidates(orphan, numbered)).toBeGreaterThan(0)
  })

  it("falls back to id so the result never depends on row order", () => {
    const a = c({ id: "aaa", score: 95 })
    const b = c({ id: "bbb", score: 95 })
    expect(compareCandidates(a, b)).toBeLessThan(0)
    expect(compareCandidates(b, a)).toBeGreaterThan(0)
  })
})
