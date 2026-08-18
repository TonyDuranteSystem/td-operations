import { describe, it, expect } from "vitest"
import { unionFieldsAcrossEntities } from "@/lib/research/entity-registry"

describe("research entity registry — unionFieldsAcrossEntities", () => {
  it("a field shared by multiple entities appears once, with both entities listed", () => {
    const union = unionFieldsAcrossEntities(["accounts", "contacts"])
    const status = union.find(u => u.field.key === "status")
    expect(status).toBeTruthy()
    expect(status!.appliesTo).toEqual(["accounts", "contacts"])
  })

  it("a field unique to one entity only lists that entity", () => {
    const union = unionFieldsAcrossEntities(["accounts", "contacts"])
    const einField = union.find(u => u.field.key === "ein_number")
    expect(einField).toBeTruthy()
    expect(einField!.appliesTo).toEqual(["accounts"])

    const citizenship = union.find(u => u.field.key === "citizenship")
    expect(citizenship).toBeTruthy()
    expect(citizenship!.appliesTo).toEqual(["contacts"])
  })

  it("a single entity produces one entry per field, each applying only to itself", () => {
    const union = unionFieldsAcrossEntities(["deals"])
    expect(union.every(u => u.appliesTo.length === 1 && u.appliesTo[0] === "deals")).toBe(true)
  })

  it("an unknown entity key is silently skipped, not an error", () => {
    const union = unionFieldsAcrossEntities(["accounts", "not_a_real_entity"])
    expect(union.length).toBeGreaterThan(0)
  })

  it("no duplicate keys ever appear in the result", () => {
    const union = unionFieldsAcrossEntities(["accounts", "contacts", "leads", "deals"])
    const keys = union.map(u => u.field.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
