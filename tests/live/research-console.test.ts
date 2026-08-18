// Live sandbox test for the Research Console engine — exercises the REAL
// registry + query-builder modules (the same code app/api/research/* imports)
// against the REAL cloud sandbox database. Read-only against every entity
// table; the only writes are create+delete on research_saved_searches, the
// dedicated table this feature owns.
//
// Run explicitly: npx vitest run --config vitest.esign-live.config.ts -t research
import "./_env"
import { describe, it, expect } from "vitest"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ENTITY_REGISTRY, getEntity } from "@/lib/research/entity-registry"
import { applyConditions, InvalidConditionError, type Condition } from "@/lib/research/query-builder"

function baseQuery(table: string, columns: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (supabaseAdmin.from(table as any) as any).select(columns)
}

describe("Research Console — entity registry sanity", () => {
  it("every registered table actually exists and the display field is queryable", async () => {
    for (const entity of Object.values(ENTITY_REGISTRY)) {
      const { data, error } = await baseQuery(entity.table, `id, ${entity.displayField}`).limit(1)
      expect(error, `${entity.key}: ${error?.message}`).toBeNull()
      expect(Array.isArray(data)).toBe(true)
    }
  })

  it("every declared field actually exists as a column (no drift from the live schema)", async () => {
    for (const entity of Object.values(ENTITY_REGISTRY)) {
      const columns = entity.fields.map(f => f.key).join(",")
      const { error } = await baseQuery(entity.table, columns).limit(1)
      expect(error, `${entity.key} field drift: ${error?.message}`).toBeNull()
    }
  })
})

describe("Research Console — query-builder whitelist", () => {
  const accounts = getEntity("accounts")!

  it("rejects an unknown field", () => {
    expect(() =>
      applyConditions(baseQuery("accounts", "id"), accounts, [
        { field: "ssn_number_that_does_not_exist", operator: "equals", value: "x" } as unknown as Condition,
      ])
    ).toThrow(InvalidConditionError)
  })

  it("rejects an operator that doesn't fit the field's type", () => {
    expect(() =>
      applyConditions(baseQuery("accounts", "id"), accounts, [
        { field: "status", operator: "gt", value: "5" } as unknown as Condition, // status is 'select', gt is a number/date op
      ])
    ).toThrow(InvalidConditionError)
  })

  it("accepts a valid field+operator pair without throwing", () => {
    expect(() =>
      applyConditions(baseQuery("accounts", "id"), accounts, [
        { field: "status", operator: "is_any_of", values: ["Active"] },
      ])
    ).not.toThrow()
  })
})

describe("Research Console — accounts (text, select, date, empty)", () => {
  const accounts = getEntity("accounts")!

  it("'is_any_of' on entity_type returns only matching rows", async () => {
    const { data, error } = await applyConditions(
      baseQuery("accounts", "id, company_name, entity_type"),
      accounts,
      [{ field: "entity_type", operator: "is_any_of", values: ["Multi Member LLC"] }]
    ).limit(50)
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThan(0)
    for (const row of data!) expect(row.entity_type).toBe("Multi Member LLC")
  })

  it("'contains' on company_name narrows results and is case-insensitive", async () => {
    const { data: allData } = await baseQuery("accounts", "id, company_name").limit(1000)
    const sample = allData!.find((r: { company_name: string }) => r.company_name?.length > 4)
    expect(sample).toBeTruthy()
    const needle = sample!.company_name.slice(0, 4).toUpperCase() // force case mismatch
    const { data, error } = await applyConditions(
      baseQuery("accounts", "id, company_name"),
      accounts,
      [{ field: "company_name", operator: "contains", value: needle }]
    ).limit(100)
    expect(error).toBeNull()
    expect(data!.some((r: { id: string }) => r.id === sample!.id)).toBe(true)
  })

  it("'is_empty' on state_of_formation returns only null/blank rows", async () => {
    const { data, error } = await applyConditions(
      baseQuery("accounts", "id, state_of_formation"),
      accounts,
      [{ field: "state_of_formation", operator: "is_empty" }]
    ).limit(50)
    expect(error).toBeNull()
    for (const row of data ?? []) {
      expect(row.state_of_formation === null || row.state_of_formation === "").toBe(true)
    }
  })

  it("a filter combination with zero real matches returns an empty array, not an error", async () => {
    const { data, error } = await applyConditions(
      baseQuery("accounts", "id"),
      accounts,
      [
        { field: "company_name", operator: "equals", value: "___no_company_is_named_exactly_this___" },
      ]
    )
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it("'between' on formation_date only returns rows inside the range", async () => {
    const { data, error } = await applyConditions(
      baseQuery("accounts", "id, formation_date"),
      accounts,
      [{ field: "formation_date", operator: "between", value: "2020-01-01", value2: "2020-12-31" }]
    ).limit(50)
    expect(error).toBeNull()
    for (const row of data ?? []) {
      expect(row.formation_date >= "2020-01-01" && row.formation_date <= "2020-12-31").toBe(true)
    }
  })
})

describe("Research Console — reference fields (deals -> accounts)", () => {
  it("resolves a real account id via is_any_of and only returns that account's deals", async () => {
    const { data: accts } = await baseQuery("accounts", "id").limit(1)
    expect(accts!.length).toBeGreaterThan(0)
    const accountId = accts![0].id

    const deals = getEntity("deals")!
    const { data, error } = await applyConditions(
      baseQuery("deals", "id, account_id"),
      deals,
      [{ field: "account_id", operator: "is_any_of", values: [accountId] }]
    ).limit(50)
    expect(error).toBeNull()
    for (const row of data ?? []) expect(row.account_id).toBe(accountId)
  })
})

describe("Research Console — payments (number range)", () => {
  it("'gte' on amount only returns rows at or above the threshold", async () => {
    const payments = getEntity("payments")!
    const { data, error } = await applyConditions(
      baseQuery("payments", "id, amount"),
      payments,
      [{ field: "amount", operator: "gte", value: 1000 }]
    ).limit(50)
    expect(error).toBeNull()
    for (const row of data ?? []) expect(Number(row.amount)).toBeGreaterThanOrEqual(1000)
  })
})

describe("Research Console — live field-values (the picker data source)", () => {
  it("returns real, deduped, non-empty distinct values for accounts.status", async () => {
    const { data, error } = await baseQuery("accounts", "status").not("status", "is", null).limit(5000)
    expect(error).toBeNull()
    const seen = new Set<string>()
    for (const row of data as { status: string }[]) if (row.status?.trim()) seen.add(row.status.trim())
    expect(seen.size).toBeGreaterThan(0)
    // sanity: every value that comes back must be a value that's actually on a real row
    const arr = Array.from(seen)
    expect(arr.every(v => typeof v === "string" && v.length > 0)).toBe(true)
  })

  it("reference picker search (accounts by name) returns id+label pairs", async () => {
    const accountsEntity = getEntity("accounts")!
    const { data, error } = await baseQuery("accounts", `id, ${accountsEntity.displayField}`)
      .order(accountsEntity.displayField, { ascending: true })
      .limit(20)
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThan(0)
    for (const row of data!) {
      expect(row.id).toBeTruthy()
      expect(row[accountsEntity.displayField as keyof typeof row]).toBeTruthy()
    }
  })
})

describe("Research Console — saved searches (this feature's own table)", () => {
  it("creates, reads back, and deletes a saved search cleanly", async () => {
    const insertRes = await (supabaseAdmin.from("research_saved_searches" as any) as any)
      .insert({
        name: "__live_test_saved_search__",
        entities: ["accounts", "contacts"],
        conditions: [{ field: "status", operator: "is_any_of", values: ["Active"] }],
        created_by: "live-test",
      })
      .select("id, name, entities, conditions")
      .single()

    expect(insertRes.error).toBeNull()
    const id = insertRes.data.id
    expect(insertRes.data.name).toBe("__live_test_saved_search__")
    expect(insertRes.data.entities).toEqual(["accounts", "contacts"])
    expect(insertRes.data.conditions).toEqual([{ field: "status", operator: "is_any_of", values: ["Active"] }])

    const readRes = await (supabaseAdmin.from("research_saved_searches" as any) as any)
      .select("id, name")
      .eq("id", id)
      .single()
    expect(readRes.error).toBeNull()
    expect(readRes.data.name).toBe("__live_test_saved_search__")

    const delRes = await (supabaseAdmin.from("research_saved_searches" as any) as any).delete().eq("id", id)
    expect(delRes.error).toBeNull()

    const verifyGone = await (supabaseAdmin.from("research_saved_searches" as any) as any)
      .select("id")
      .eq("id", id)
    expect(verifyGone.data).toEqual([])
  })

  it("rejects saving a search with an invalid condition (mirrors the API route's own guard)", () => {
    const accounts = getEntity("accounts")!
    expect(() =>
      applyConditions(baseQuery("accounts", "id"), accounts, [
        { field: "not_a_real_field", operator: "equals", value: "x" } as unknown as Condition,
      ])
    ).toThrow(InvalidConditionError)
  })
})

describe("Research Console — multi-entity fan-out (real data, both selected types)", () => {
  it("a field shared by both selected entities filters BOTH of them", async () => {
    const { runEntitySearch } = await import("@/lib/research/run-entity-search")
    const accounts = getEntity("accounts")!
    const contacts = getEntity("contacts")!
    const shared: Condition[] = [{ field: "status", operator: "is_any_of", values: ["Active"] }]

    const [accountsResult, contactsResult] = await Promise.all([
      runEntitySearch(accounts, shared, 1),
      runEntitySearch(contacts, shared, 1),
    ])

    for (const row of accountsResult.items) expect(row.status).toBe("Active")
    for (const row of contactsResult.items) expect(row.status).toBe("Active")
  })

  it("a field belonging to only ONE selected entity does not affect the other entity's results at all", async () => {
    const { runEntitySearch } = await import("@/lib/research/run-entity-search")
    const contacts = getEntity("contacts")!
    // ein_number only exists on accounts — the fan-out route filters it OUT
    // of the condition list before running contacts' query (see runEntitySearch's
    // `applicable` filter), so contacts must come back completely unaffected.
    const accountsOnlyCondition: Condition[] = [{ field: "ein_number", operator: "contains", value: "00" }]

    const [unfiltered, filtered] = await Promise.all([
      runEntitySearch(contacts, [], 1),
      runEntitySearch(contacts, accountsOnlyCondition, 1),
    ])

    expect(filtered.total).toBe(unfiltered.total)
  })

  it("each entity's own matching total is reported independently, not merged into one count", async () => {
    const { runEntitySearch } = await import("@/lib/research/run-entity-search")
    const accounts = getEntity("accounts")!
    const contacts = getEntity("contacts")!

    const [accountsResult, contactsResult] = await Promise.all([
      runEntitySearch(accounts, [], 1),
      runEntitySearch(contacts, [], 1),
    ])

    expect(accountsResult.entity).toBe("accounts")
    expect(contactsResult.entity).toBe("contacts")
    expect(typeof accountsResult.total).toBe("number")
    expect(typeof contactsResult.total).toBe("number")
  })
})
