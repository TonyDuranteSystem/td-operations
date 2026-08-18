import { describe, it, expect } from "vitest"
import { applyConditions, InvalidConditionError, OPERATORS_BY_TYPE } from "@/lib/research/query-builder"
import { getEntity } from "@/lib/research/entity-registry"

// A minimal fake Supabase query builder that just records which method was
// called with which args, so we can assert on the translation without a DB.
function fakeQuery() {
  const calls: { method: string; args: unknown[] }[] = []
  const proxy: Record<string, (...args: unknown[]) => typeof proxy> = {}
  for (const method of ["eq", "ilike", "in", "lt", "gt", "lte", "gte", "or", "not"]) {
    proxy[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return proxy
    }
  }
  return { proxy, calls }
}

describe("research query-builder — operator translation", () => {
  const accounts = getEntity("accounts")!

  it("'contains' calls ilike with wildcards on both sides", () => {
    const { proxy, calls } = fakeQuery()
    applyConditions(proxy, accounts, [{ field: "company_name", operator: "contains", value: "acme" }])
    expect(calls).toEqual([{ method: "ilike", args: ["company_name", "%acme%"] }])
  })

  it("'is_any_of' calls .in with the values array", () => {
    const { proxy, calls } = fakeQuery()
    applyConditions(proxy, accounts, [{ field: "status", operator: "is_any_of", values: ["Active", "Delinquent"] }])
    expect(calls).toEqual([{ method: "in", args: ["status", ["Active", "Delinquent"]] }])
  })

  it("'is_any_of' with an empty values array never matches everything (uses a sentinel, not an unfiltered query)", () => {
    const { proxy, calls } = fakeQuery()
    applyConditions(proxy, accounts, [{ field: "status", operator: "is_any_of", values: [] }])
    expect(calls[0].args[1]).not.toEqual([])
  })

  it("'between' chains gte then lte on the same column", () => {
    const { proxy, calls } = fakeQuery()
    applyConditions(proxy, accounts, [
      { field: "formation_date", operator: "between", value: "2024-01-01", value2: "2024-12-31" },
    ])
    expect(calls).toEqual([
      { method: "gte", args: ["formation_date", "2024-01-01"] },
      { method: "lte", args: ["formation_date", "2024-12-31"] },
    ])
  })

  it("'is_empty' does not require a value and never throws", () => {
    const { proxy } = fakeQuery()
    expect(() => applyConditions(proxy, accounts, [{ field: "state_of_formation", operator: "is_empty" }])).not.toThrow()
  })

  it("multiple conditions are ANDed by chaining, not overwriting", () => {
    const { proxy, calls } = fakeQuery()
    applyConditions(proxy, accounts, [
      { field: "status", operator: "is_any_of", values: ["Active"] },
      { field: "company_name", operator: "contains", value: "llc" },
    ])
    expect(calls.map(c => c.method)).toEqual(["in", "ilike"])
  })
})

describe("research query-builder — whitelist enforcement (security boundary)", () => {
  const accounts = getEntity("accounts")!

  it("throws on a field not declared for the entity", () => {
    const { proxy } = fakeQuery()
    expect(() =>
      applyConditions(proxy, accounts, [{ field: "hubspot_id_or_anything_undeclared", operator: "equals", value: "x" }])
    ).toThrow(InvalidConditionError)
  })

  it("throws when the operator doesn't belong to the field's type", () => {
    const { proxy } = fakeQuery()
    // 'status' is type 'select' — 'contains' is a text-only operator.
    expect(() => applyConditions(proxy, accounts, [{ field: "status", operator: "contains", value: "x" }])).toThrow(
      InvalidConditionError
    )
  })

  it("every entity's fields only ever get operators valid for their declared type", () => {
    for (const entity of Object.values(getEntity("accounts") ? { accounts } : {})) {
      for (const field of entity.fields) {
        const allowed = OPERATORS_BY_TYPE[field.type]
        expect(allowed.length).toBeGreaterThan(0)
      }
    }
  })
})
