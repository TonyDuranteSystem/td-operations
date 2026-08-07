import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { loadRenewalStatuses } from "@/lib/operations/renewal-status-loader"

/**
 * Loader tests with a scripted fake supabase client: verifies the batched
 * join-in-code, pagination, roster filtering, and the money-gate query shape
 * (test payments excluded via NOT IS TRUE, never .neq).
 */

type Row = Record<string, unknown>

interface TableFixture {
  rows: Row[]
}

function fakeClient(tables: Record<string, TableFixture>) {
  const calls: Array<{ table: string; filters: string[] }> = []
  const client = {
    from(table: string) {
      const filters: string[] = []
      let rows = [...(tables[table]?.rows ?? [])]
      let start = 0
      let end = rows.length - 1
      const builder = {
        select() { return builder },
        eq(col: string, v: unknown) {
          filters.push(`eq:${col}=${v}`)
          rows = rows.filter(r => r[col] === v)
          return builder
        },
        in(col: string, vals: unknown[]) {
          filters.push(`in:${col}=${vals.join("|")}`)
          rows = rows.filter(r => vals.includes(r[col]))
          return builder
        },
        not(col: string, op: string, v: unknown) {
          filters.push(`not:${col}.${op}.${v}`)
          if (op === "is" && v === true) rows = rows.filter(r => r[col] !== true)
          return builder
        },
        order() { return builder },
        range(from: number, to: number) {
          start = from
          end = to
          return builder
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          calls.push({ table, filters })
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null }).then(resolve)
        },
      }
      return builder
    },
  }
  const typed: SupabaseClient = client as never
  return { client: typed, calls }
}

const TODAY = "2026-08-06"

function account(over: Row = {}): Row {
  return {
    id: "acc-1",
    company_name: "Loader QA LLC",
    account_type: "Client",
    status: "Active",
    state_of_formation: "Wyoming",
    formation_date: "2024-08-10",
    ra_renewal_date: "2027-08-10",
    annual_report_due_date: "2027-08-01",
    is_test: false,
    is_internal: false,
    ein_number: "12-3456789",
    entity_type: "Single Member LLC",
    registered_agent_id: null,
    registered_agent_provider: null,
    registered_agent_address: null,
    gdrive_folder_url: null,
    drive_folder_id: null,
    portal_tier: "active",
    ...over,
  }
}

describe("loadRenewalStatuses", () => {
  it("joins SDs, payments, closures per account and computes statuses", async () => {
    const { client } = fakeClient({
      accounts: { rows: [
        account(),
        account({ id: "acc-2", company_name: "Held LLC", ra_renewal_date: "2026-08-20" }),
      ] },
      service_deliveries: { rows: [
        { id: "sd-1", account_id: "acc-1", service_type: "State RA Renewal", status: "active", stage: null, stage_order: null, due_date: "2027-08-10" },
        { id: "sd-x", account_id: "other", service_type: "State RA Renewal", status: "active", stage: null, stage_order: null, due_date: "2027-01-01" },
        { id: "sd-c", account_id: "acc-2", service_type: "Company Closure", status: "active", stage: null, stage_order: null, due_date: null },
      ] },
      payments: { rows: [
        { id: "p-1", account_id: "acc-2", amount: 849, amount_currency: "EUR", status: "Overdue", due_date: "2026-06-01" },
        { id: "p-other", account_id: "other", amount: 100, amount_currency: "USD", status: "Overdue", due_date: "2026-06-01" },
      ] },
      tax_returns: { rows: [] },
    })
    const result = await loadRenewalStatuses(client, { today: TODAY })
    expect(result).toHaveLength(2)

    const clean = result.find(r => r.account.id === "acc-1")!
    expect(clean.status.ra.status).toBe("renewed")
    expect(clean.status.onCalendar).toBe(true)

    const held = result.find(r => r.account.id === "acc-2")!
    expect(held.status.ra.status).toBe("on_hold_unpaid")
    expect(held.status.ra.evidence.paymentIds).toEqual(["p-1"])
    expect(held.status.ra.cause).toContain("EUR 849")
    expect(held.status.closing).toBe(true) // active Company Closure SD
  })

  it("excludes test payments via NOT IS TRUE (NULL is_test rows are kept)", async () => {
    const { client, calls } = fakeClient({
      accounts: { rows: [account({ ra_renewal_date: "2026-08-20" })] },
      service_deliveries: { rows: [] },
      payments: { rows: [
        { id: "p-null", account_id: "acc-1", amount: 100, amount_currency: "USD", status: "Overdue", due_date: "2026-05-01", is_test: null },
        { id: "p-test", account_id: "acc-1", amount: 200, amount_currency: "USD", status: "Overdue", due_date: "2026-05-01", is_test: true },
      ] },
      tax_returns: { rows: [] },
    })
    const result = await loadRenewalStatuses(client, { today: TODAY })
    // NULL-is_test payment holds; the test payment is filtered out
    expect(result[0].status.ra.status).toBe("on_hold_unpaid")
    expect(result[0].status.ra.evidence.paymentIds).toEqual(["p-null"])
    const payCall = calls.find(c => c.table === "payments")!
    expect(payCall.filters).toContain("not:is_test.is.true")
  })

  it("One-Time accounts are computed but off-calendar; roster excludes non-Active", async () => {
    const { client } = fakeClient({
      accounts: { rows: [
        account({ id: "ot-1", account_type: "One-Time", company_name: "Cleo Home LLC" }),
        account({ id: "inactive", status: "Inactive" }),
      ] },
      service_deliveries: { rows: [] },
      payments: { rows: [] },
      tax_returns: { rows: [] },
    })
    const result = await loadRenewalStatuses(client, { today: TODAY })
    expect(result).toHaveLength(1) // Inactive filtered by the roster query
    expect(result[0].account.id).toBe("ot-1")
    expect(result[0].status.onCalendar).toBe(false)
    expect(result[0].status.ra.status).toBe("not_applicable")
  })

  it("paginates past 1000 rows instead of silently truncating", async () => {
    const manySds: Row[] = Array.from({ length: 1005 }, (_, i) => ({
      id: `sd-${i}`,
      account_id: "acc-1",
      service_type: "State RA Renewal",
      status: "completed",
      stage: null,
      stage_order: null,
      due_date: "2025-08-10",
    }))
    const { client } = fakeClient({
      accounts: { rows: [account({ ra_renewal_date: "2025-08-10" })] },
      service_deliveries: { rows: manySds },
      payments: { rows: [] },
      tax_returns: { rows: [] },
    })
    const result = await loadRenewalStatuses(client, { today: TODAY })
    // All 1005 completed SDs must be visible to the engine (evidence proves it)
    expect(result[0].status.ra.evidence.sdIds).toHaveLength(1005)
    expect(result[0].status.ra.status).toBe("overdue")
    expect(result[0].status.ra.cause).toContain("never rolled")
  })

  it("latest tax return per account feeds classification (legacy-client path)", async () => {
    const { client } = fakeClient({
      accounts: { rows: [account({ formation_date: null, ein_number: null })] },
      service_deliveries: { rows: [] },
      payments: { rows: [] },
      tax_returns: { rows: [
        { account_id: "acc-1", tax_year: 2025, status: "Filed", extension_filed: false, first_year_skip: false },
        { account_id: "acc-1", tax_year: 2024, status: "Filed", extension_filed: false, first_year_skip: false },
      ] },
    })
    const result = await loadRenewalStatuses(client, { today: TODAY })
    // Tax-return presence → formationComplete → still a real (Client) roster row
    expect(result[0].status.onCalendar).toBe(true)
    expect(result[0].status.ra.status).toBe("renewed")
  })

  it("empty roster returns [] without touching child tables", async () => {
    const { client, calls } = fakeClient({
      accounts: { rows: [] },
      service_deliveries: { rows: [] },
      payments: { rows: [] },
      tax_returns: { rows: [] },
    })
    const result = await loadRenewalStatuses(client, { today: TODAY })
    expect(result).toEqual([])
    expect(calls.map(c => c.table)).toEqual(["accounts"])
  })
})
