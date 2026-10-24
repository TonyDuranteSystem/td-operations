import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { CLIENT_OWNER_KINDS, isClientOwnerKind, isInternalOwnerKind } from "@/lib/crm-store/owner-kinds"

describe("owner kinds — which storages face a client", () => {
  it("client companies and people are client storages", () => {
    for (const k of ["company", "person", "formation", "unfiled"]) { expect(isClientOwnerKind(k)).toBe(true); expect(isInternalOwnerKind(k)).toBe(false) }
  })
  it("Business, My files and any kind added later are firm storages without naming them", () => {
    for (const k of ["business", "private", "marketing", "anything-new"]) { expect(isInternalOwnerKind(k)).toBe(true); expect(isClientOwnerKind(k)).toBe(false) }
  })
  it("an unknown or missing kind is never trusted as a firm storage", () => {
    expect(isInternalOwnerKind(undefined)).toBe(false)
    expect(isInternalOwnerKind(null)).toBe(false)
    expect(isInternalOwnerKind("")).toBe(false)
  })
  it("every storage kind the database allows is classified: a new kind added to the CHECK must be decided here", () => {
    const sql = readFileSync("scripts/migrations/20260927-1000-crm-store-structure.sql", "utf8")
    const m = sql.match(/CHECK \(kind IN \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const kinds = m![1].split(",").map((x) => x.trim().replace(/'/g, ""))
    // today's allowed kinds, each one either a client kind or (deliberately) a firm kind
    expect(kinds.sort()).toEqual(["business", "company", "formation", "person", "private", "unfiled"])
    for (const k of kinds) expect(isClientOwnerKind(k) !== isInternalOwnerKind(k)).toBe(true)
    expect([...CLIENT_OWNER_KINDS].sort()).toEqual(["company", "formation", "person", "unfiled"])
  })
})
