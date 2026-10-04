import { describe, it, expect, vi } from "vitest"
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
import { shapeFilteredFiles, FILTER_KINDS, pathOf } from "@/lib/crm-store/extras"

const folders = new Map([
  ["root", { name: "Prowave LLC", parent_id: null }],
  ["tax", { name: "3. Tax", parent_id: "root" }],
  ["y25", { name: "2025", parent_id: "tax" }],
  ["bs", { name: "Bank Statements", parent_id: "y25" }],
  ["co", { name: "1. Company", parent_id: "root" }],
])
const row = (id: string, name: string, folder_id: string, extra: Record<string, unknown> = {}) => ({
  id, name, folder_id, updated_at: "2026-10-04T10:00:00Z", needs_review_at: null, needs_review_reason: null, document_type: "tax_return",
  store_file_versions: { mime_type: "application/pdf", size_bytes: 1000 }, ...extra,
})

describe("shapeFilteredFiles / the 'all' filter", () => {
  it("offers 'all' next to the three existing filters", () => {
    expect([...FILTER_KINDS].sort()).toEqual(["all", "review", "shown", "untyped"])
  })

  it("'all' keeps every file and marks which ones the client sees", () => {
    const out = shapeFilteredFiles([row("a", "A.pdf", "co"), row("b", "B.pdf", "bs")], folders, new Set(["b"]), "all")
    expect(out.map((f) => f.id).sort()).toEqual(["a", "b"])
    expect(out.find((f) => f.id === "a")?.clientVisible).toBe(false)
    expect(out.find((f) => f.id === "b")?.clientVisible).toBe(true)
  })

  it("'shown' keeps only what the client sees (unchanged behaviour)", () => {
    const out = shapeFilteredFiles([row("a", "A.pdf", "co"), row("b", "B.pdf", "bs")], folders, new Set(["b"]), "shown")
    expect(out.map((f) => f.id)).toEqual(["b"])
  })

  it("gives every file its folder path without the storage's top folder, and sorts by path then name", () => {
    const out = shapeFilteredFiles([row("z", "Z.pdf", "bs"), row("a", "A.pdf", "co"), row("m", "M.pdf", "bs")], folders, new Set(), "all")
    expect(out.map((f) => `${f.where}/${f.name}`)).toEqual(["1. Company/A.pdf", "3. Tax › 2025 › Bank Statements/M.pdf", "3. Tax › 2025 › Bank Statements/Z.pdf"])
    expect(pathOf("bs", folders)).toBe("3. Tax › 2025 › Bank Statements")
  })

  it("carries the review reason, the type and a missing size/mime as null", () => {
    const out = shapeFilteredFiles([row("r", "R.pdf", "co", { needs_review_at: "2026-10-04", needs_review_reason: "total differs", document_type: null, store_file_versions: null })], folders, new Set(), "all")
    expect(out[0]).toMatchObject({ needsReview: "total differs", documentType: null, mimeType: null, size: null })
  })

  it("a review flag without a reason still says 'Needs review'", () => {
    const out = shapeFilteredFiles([row("r", "R.pdf", "co", { needs_review_at: "2026-10-04" })], folders, new Set(), "review")
    expect(out[0].needsReview).toBe("Needs review")
  })

  it("an empty storage gives an empty list", () => {
    expect(shapeFilteredFiles([], folders, new Set(), "all")).toEqual([])
  })
})
