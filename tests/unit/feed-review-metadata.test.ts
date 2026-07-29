/**
 * The review-metadata vocabulary: the contested set a human reads, and the rejected-pair
 * memory the automatic matcher OBEYS.
 *
 * The memory is load-bearing, not audit decoration: un-matching returns a transaction to the
 * unmatched pool and the bank sync re-runs every 15 minutes, so without it the matcher
 * re-proposes — and can re-apply — the exact pair a human just undid.
 */

import { describe, it, expect } from "vitest"
import {
  contestedMetadata,
  readContestedCandidates,
  appendRejectedPair,
  readRejectedPairs,
  isRejectedPair,
  auditLinkMetadata,
} from "@/lib/finance/feed-vocabulary"

const AT = "2026-07-29T12:00:00.000Z"

describe("contested set", () => {
  it("round-trips the candidates a human needs to choose between", () => {
    const meta = contestedMetadata(
      [
        { payment_id: "p1", invoice_number: "INV-002151", client_name: "Aces Marketing Solutions LLC", score: 95, confidence: "exact" },
        { payment_id: "p2", invoice_number: "INV-002194", client_name: "LC Marketing Consulting LLC", score: 95, confidence: "exact" },
      ],
      AT,
    )
    const read = readContestedCandidates(meta)
    expect(read).toHaveLength(2)
    expect(read.map((c) => c.client_name)).toContain("LC Marketing Consulting LLC")
    expect(meta.contested.reason).toBe("tied_candidates")
  })

  it("reads nothing off a row that is not contested", () => {
    expect(readContestedCandidates(null)).toEqual([])
    expect(readContestedCandidates({})).toEqual([])
    expect(readContestedCandidates({ contested: "yes" })).toEqual([])
    expect(readContestedCandidates({ contested: { candidates: "nope" } })).toEqual([])
    expect(readContestedCandidates([1, 2, 3])).toEqual([])
  })

  it("ignores malformed candidate entries rather than throwing", () => {
    const read = readContestedCandidates({
      contested: { candidates: [{ payment_id: "ok" }, null, 42, { nope: true }] },
    })
    expect(read).toHaveLength(1)
    expect(read[0].payment_id).toBe("ok")
  })
})

describe("rejected-pair memory", () => {
  it("records a rejection and reads it back", () => {
    const patch = appendRejectedPair(null, { payment_id: "aces-inv", at: AT, by: "luca" })
    expect(isRejectedPair(patch, "aces-inv")).toBe(true)
    expect(isRejectedPair(patch, "lc-inv")).toBe(false)
  })

  it("accumulates rejections across several invoices", () => {
    const first = appendRejectedPair(null, { payment_id: "a", at: AT, by: "luca" })
    const second = appendRejectedPair(first, { payment_id: "b", at: AT, by: "luca" })
    expect(readRejectedPairs(second).map((p) => p.payment_id).sort()).toEqual(["a", "b"])
  })

  it("does not duplicate a pair rejected twice", () => {
    const first = appendRejectedPair(null, { payment_id: "a", at: AT, by: "luca" })
    const again = appendRejectedPair(first, { payment_id: "a", at: "2026-07-30T00:00:00.000Z", by: "antonio" })
    const pairs = readRejectedPairs(again)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].by).toBe("antonio")
  })

  it("survives being merged alongside OTHER review_metadata facts", () => {
    // This is the failure the merge fix exists for: the audit-link write, the refund flag and
    // the multi-match allocation each used to REPLACE the whole column, erasing the memory.
    const withRejection = appendRejectedPair(null, { payment_id: "a", at: AT, by: "luca" })
    const merged = {
      ...withRejection,
      ...auditLinkMetadata("manual", "linked for the trail"),
      ...contestedMetadata([{ payment_id: "b", invoice_number: null, client_name: null, score: 95, confidence: "exact" }], AT),
      multi_match_allocations: [{ payment_id: "z", amount: 600 }],
    }
    expect(isRejectedPair(merged, "a")).toBe(true)
    expect(readContestedCandidates(merged)).toHaveLength(1)
    expect(merged.multi_match_allocations).toHaveLength(1)
    expect(merged.audit_link).toBe(true)
  })

  it("reads nothing off malformed metadata", () => {
    expect(readRejectedPairs(null)).toEqual([])
    expect(readRejectedPairs({ rejected_pairs: "nope" })).toEqual([])
    expect(readRejectedPairs({ rejected_pairs: [null, 1, { payment_id: 5 }] })).toEqual([])
    expect(isRejectedPair(undefined, "a")).toBe(false)
  })
})
