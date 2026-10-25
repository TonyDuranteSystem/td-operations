import { describe, it, expect } from "vitest"
import { checkReplacement, lockText, conflictText, warningText } from "@/lib/crm-store/new-version-rules"
import { mintConfirmToken, verifyConfirmToken, CONFIRM_TOKEN_TTL_MS } from "@/lib/crm-store/confirm-token"

const old = { name: "Report.pdf", mimeType: "application/pdf", size: 100_000 }

describe("checkReplacement", () => {
  it("blocks an empty file", () => {
    expect(checkReplacement(old, { name: "Report.pdf", mimeType: null, size: 0 }).block).toMatch(/empty/)
  })
  it("accepts the same type and a similar size", () => {
    expect(checkReplacement(old, { name: "Report v2.PDF", mimeType: null, size: 90_000 })).toEqual({ block: null, warnings: [] })
  })
  it("warns for a different type", () => {
    expect(checkReplacement(old, { name: "Report.docx", mimeType: null, size: 90_000 }).warnings).toEqual(["different_type"])
  })
  it("treats jpg and jpeg as the same", () => {
    expect(checkReplacement({ ...old, name: "a.jpg" }, { name: "b.jpeg", mimeType: null, size: 100_000 }).warnings).toEqual([])
  })
  it("warns when much smaller, but not for small files", () => {
    expect(checkReplacement(old, { name: "Report.pdf", mimeType: null, size: 5_000 }).warnings).toEqual(["much_smaller"])
    expect(checkReplacement({ ...old, size: 2_000 }, { name: "Report.pdf", mimeType: null, size: 10 }).warnings).toEqual([])
  })
  it("handles an unknown old size and no extension", () => {
    expect(checkReplacement({ name: "notes", mimeType: null, size: null }, { name: "notes", mimeType: null, size: 5 })).toEqual({ block: null, warnings: [] })
  })
})

describe("plain words", () => {
  it("names the reason for each lock", () => {
    expect(lockText("signed", "A.pdf")).toMatch(/signed/)
    expect(lockText("replace_only", "P.pdf")).toMatch(/passport or ID/)
    expect(lockText("replaced", "O.pdf")).toMatch(/replaced/)
    expect(lockText("filed", "R.pdf")).toMatch(/filed return/)
    expect(lockText(null, "X.pdf")).toMatch(/can't be edited/)
  })
  it("says nothing was overwritten on a conflict", () => {
    expect(conflictText({ name: "A.pdf", currentVersionNo: 4, by: "Luca" })).toMatch(/NOT been saved/)
  })
  it("words the warnings", () => {
    expect(warningText("different_type", "a.pdf", "a.docx")).toMatch(/different kind/)
    expect(warningText("much_smaller", "a.pdf", "b.pdf")).toMatch(/90%/)
  })
})

describe("confirm token", () => {
  const s = { fileId: "f1", baseVersionNo: 2, userId: "u1", sha256: "abc" }
  const key = "test-key"
  it("verifies for the same scope", () => {
    const t = mintConfirmToken(s, 1000, key)!
    expect(verifyConfirmToken(t, s, 2000, key)).toBe(true)
  })
  it("fails for any other file, base, person or bytes", () => {
    const t = mintConfirmToken(s, 1000, key)!
    for (const o of [{ fileId: "f2" }, { baseVersionNo: 3 }, { userId: "u2" }, { sha256: "abd" }]) expect(verifyConfirmToken(t, { ...s, ...o }, 2000, key)).toBe(false)
  })
  it("expires and rejects junk", () => {
    const t = mintConfirmToken(s, 1000, key)!
    expect(verifyConfirmToken(t, s, 1000 + CONFIRM_TOKEN_TTL_MS + 1, key)).toBe(false)
    expect(verifyConfirmToken("junk", s, 2000, key)).toBe(false)
    expect(verifyConfirmToken("", s, 2000, key)).toBe(false)
    expect(verifyConfirmToken(null, s, 2000, key)).toBe(false)
  })
  it("fails closed without a key", () => {
    expect(mintConfirmToken(s, 1000, null)).toBeNull()
    expect(verifyConfirmToken("1.x", s, 0, null)).toBe(false)
  })
})
