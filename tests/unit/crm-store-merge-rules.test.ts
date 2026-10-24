import { describe, it, expect } from "vitest"
import { mergeBlockReason, type MergeCandidate } from "@/lib/crm-store/merge-rules"

const f = (over: Partial<MergeCandidate> = {}): MergeCandidate => ({ name: "a.pdf", state: "live", staffOnly: false, personal: false, needsReview: null, filingStatus: "none", ownerKey: "owner-1", ownerKind: "company", ...over })
const biz = (over: Partial<MergeCandidate> = {}) => f({ ownerKey: "biz-1", ownerKind: "business", ...over })
const mine = (over: Partial<MergeCandidate> = {}) => f({ ownerKey: "mine-1", ownerKind: "private", ...over })

describe("mergeBlockReason — which ticked files may be merged", () => {
  it("two ordinary files of one company: allowed", () => {
    expect(mergeBlockReason([f(), f({ name: "b.pdf" })])).toBeNull()
  })
  it("fewer than two: refused", () => {
    expect(mergeBlockReason([f()])).toMatch(/at least two/)
  })
  it("files of two different client owners (company vs person, or two companies): refused", () => {
    expect(mergeBlockReason([f(), f({ ownerKey: "owner-2" })])).toMatch(/SAME company or person/)
    expect(mergeBlockReason([f(), f({ ownerKey: "p-1", ownerKind: "person" })])).toMatch(/SAME company or person/)
  })
  it("a client file is never mixed with a firm storage file", () => {
    expect(mergeBlockReason([f(), biz()])).toMatch(/SAME company or person/)
    expect(mergeBlockReason([mine(), f()])).toMatch(/SAME company or person/)
  })
  it("a file whose owner could not be worked out is refused, never guessed", () => {
    expect(mergeBlockReason([f(), f({ ownerKey: undefined })])).toMatch(/Could not tell which storage/)
  })
  it("a trashed file is refused and named", () => {
    expect(mergeBlockReason([f(), f({ name: "old.pdf", state: "trashed" })])).toMatch(/"old\.pdf" is in the trash/)
  })
  it("in a client storage a staff-only file, a draft return, a 'Needs review' file are refused and named", () => {
    expect(mergeBlockReason([f(), f({ name: "s.pdf", staffOnly: true })])).toMatch(/"s\.pdf" is staff-only/)
    expect(mergeBlockReason([f(), f({ name: "d.pdf", filingStatus: "draft" })])).toMatch(/"d\.pdf" is a draft return/)
    expect(mergeBlockReason([f(), f({ name: "n.pdf", needsReview: "check it" })])).toMatch(/"n\.pdf" is marked "Needs review"/)
  })
  it("a filed or amended return is fine", () => {
    expect(mergeBlockReason([f({ filingStatus: "filed" }), f({ filingStatus: "amended" })])).toBeNull()
  })
  it("a personal document is merged only inside the person's own storage", () => {
    expect(mergeBlockReason([f({ personal: true }), f()])).toMatch(/personal document/)
    expect(mergeBlockReason([f({ personal: true, ownerKind: "person" }), f({ personal: true, ownerKind: "person" })])).toBeNull()
  })
  it("in a firm storage the protection flags do not apply (never shown to a client), but trash still does", () => {
    expect(mergeBlockReason([biz({ staffOnly: true }), biz({ filingStatus: "draft" })])).toBeNull()
    expect(mergeBlockReason([biz(), biz({ state: "trashed" })])).toMatch(/trash/)
  })
  it("Antonio 2026-10-24: one file from Business and one from My files can be merged", () => {
    expect(mergeBlockReason([biz(), mine()])).toBeNull()
  })
  it("any firm storage kind added later mixes the same way (nothing is named in the rule)", () => {
    expect(mergeBlockReason([biz(), f({ ownerKey: "mkt-1", ownerKind: "marketing" }), mine()])).toBeNull()
  })
  it("a storage whose kind is unknown is NOT trusted as a firm storage", () => {
    expect(mergeBlockReason([biz(), f({ ownerKey: "x", ownerKind: undefined })])).toMatch(/SAME company or person/)
  })
})
