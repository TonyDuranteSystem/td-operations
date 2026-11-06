/**
 * Invoice departments, step 2 (dev job ac893719): the Finance switch. The `?dept=` value is checked against the catalog, the counts come from the rows
 * already loaded, and a bad link shows everything instead of hiding invoices. Pure functions, no database.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { applyDepartmentFilter, buildDepartmentSwitches, departmentFilterMatches, resolveDepartmentFilter } from "@/lib/invoices/departments"

const DEFAULT_ID = "11111111-1111-1111-1111-111111111111"
const MARKETING_ID = "22222222-2222-2222-2222-222222222222"
const THIRD_ID = "33333333-3333-3333-3333-333333333333"

const td = (over: Record<string, unknown> = {}) => ({ id: DEFAULT_ID, slug: "td_clients", display_name: "TD clients", status: "active", metadata: { is_default: true, origins: [], sort_order: 10 }, ...over })
const mk = (over: Record<string, unknown> = {}) => ({ id: MARKETING_ID, slug: "td_marketing", display_name: "TD Marketing", status: "active", metadata: { origins: ["marketing_sale"], sort_order: 20 }, ...over })
const third = (over: Record<string, unknown> = {}) => ({ id: THIRD_ID, slug: "td_other", display_name: "TD Other", status: "active", metadata: { origins: [], sort_order: 30 }, ...over })

describe("resolveDepartmentFilter", () => {
  const entries = [td(), mk()] as never[]
  it("no value, empty value or an unknown slug means all", () => {
    expect(resolveDepartmentFilter(entries, undefined)).toEqual({ kind: "all" })
    expect(resolveDepartmentFilter(entries, "")).toEqual({ kind: "all" })
    expect(resolveDepartmentFilter(entries, "nonsense")).toEqual({ kind: "all" })
  })
  it("the default department filters on NOTHING stored", () => {
    expect(resolveDepartmentFilter(entries, "td_clients")).toEqual({ kind: "default" })
  })
  it("a non-default department filters on its id", () => {
    expect(resolveDepartmentFilter(entries, "td_marketing")).toEqual({ kind: "department", id: MARKETING_ID })
  })
  it("a retired department with no invoices is not selectable, one that still holds invoices is", () => {
    const retired = [td(), mk({ status: "deprecated" })] as never[]
    expect(resolveDepartmentFilter(retired, "td_marketing")).toEqual({ kind: "all" })
    expect(resolveDepartmentFilter(retired, "td_marketing", new Set([MARKETING_ID]))).toEqual({ kind: "department", id: MARKETING_ID })
  })
  it("a third department needs no code: a new catalog row is selectable", () => {
    expect(resolveDepartmentFilter([td(), mk(), third()] as never[], "td_other")).toEqual({ kind: "department", id: THIRD_ID })
  })
  it("a broken catalog (no default) fails loud rather than guessing", () => {
    expect(() => resolveDepartmentFilter([mk()] as never[], "td_marketing")).toThrow()
  })
})

describe("departmentFilterMatches", () => {
  it("all lets everything through", () => {
    expect(departmentFilterMatches({ kind: "all" }, null)).toBe(true)
    expect(departmentFilterMatches({ kind: "all" }, MARKETING_ID)).toBe(true)
  })
  it("default matches only invoices with nothing stored", () => {
    expect(departmentFilterMatches({ kind: "default" }, null)).toBe(true)
    expect(departmentFilterMatches({ kind: "default" }, undefined)).toBe(true)
    expect(departmentFilterMatches({ kind: "default" }, MARKETING_ID)).toBe(false)
  })
  it("a department matches only its own id", () => {
    expect(departmentFilterMatches({ kind: "department", id: MARKETING_ID }, MARKETING_ID)).toBe(true)
    expect(departmentFilterMatches({ kind: "department", id: MARKETING_ID }, null)).toBe(false)
    expect(departmentFilterMatches({ kind: "department", id: MARKETING_ID }, THIRD_ID)).toBe(false)
  })
})

describe("applyDepartmentFilter", () => {
  const stub = () => {
    const calls: Array<[string, string, unknown]> = []
    return { calls, is: (c: string, v: null) => { calls.push(["is", c, v]) }, eq: (c: string, v: string) => { calls.push(["eq", c, v]) } }
  }
  it("all adds nothing", () => {
    const q = stub(); applyDepartmentFilter(q, { kind: "all" })
    expect(q.calls).toEqual([])
  })
  it("default keeps only invoices with nothing stored", () => {
    const q = stub(); applyDepartmentFilter(q, { kind: "default" })
    expect(q.calls).toEqual([["is", "department_entry_id", null]])
  })
  it("a department keeps only its own id", () => {
    const q = stub(); applyDepartmentFilter(q, { kind: "department", id: MARKETING_ID })
    expect(q.calls).toEqual([["eq", "department_entry_id", MARKETING_ID]])
  })
})

describe("buildDepartmentSwitches", () => {
  const rows = [
    { department_entry_id: null }, { department_entry_id: null }, { department_entry_id: undefined },
    { department_entry_id: MARKETING_ID }, { department_entry_id: MARKETING_ID },
  ]
  it("counts NULL for the default department, in catalog order, and the counts add up to the rows", () => {
    const sw = buildDepartmentSwitches([mk(), td()] as never[], rows)
    expect(sw).toEqual([
      { slug: "td_clients", label: "TD clients", count: 3 },
      { slug: "td_marketing", label: "TD Marketing", count: 2 },
    ])
    expect(sw.reduce((n, d) => n + d.count, 0)).toBe(rows.length)
  })
  it("a department with no invoices still shows, with 0", () => {
    expect(buildDepartmentSwitches([td(), mk()] as never[], [{ department_entry_id: null }]).map(d => d.count)).toEqual([1, 0])
  })
  it("a retired department that holds invoices stays; a retired empty one goes", () => {
    const retired = [td(), mk({ status: "deprecated" })] as never[]
    expect(buildDepartmentSwitches(retired, rows).map(d => d.slug)).toEqual(["td_clients", "td_marketing"])
    expect(buildDepartmentSwitches(retired, [{ department_entry_id: null }]).map(d => d.slug)).toEqual(["td_clients"])
  })
  it("no rows at all gives zeros, not an error", () => {
    expect(buildDepartmentSwitches([td(), mk()] as never[], []).map(d => d.count)).toEqual([0, 0])
  })
})

describe("guard: the Finance page applies the department BEFORE the list is cut", () => {
  const page = readFileSync("app/(dashboard)/finance/page.tsx", "utf8")
  it("the flat list filter is applied to the query, which is awaited only after", () => {
    expect(page).toMatch(/const flatQuery = supabaseAdmin[\s\S]*?\.limit\(500\)\s*\n\s*applyDept\(flatQuery\)\s*\n\s*const \{ data: allPaymentsFlat \} = await flatQuery/)
  })
  it("the selected client's three lists follow the switch", () => {
    expect(page).toMatch(/applyDept\(invoiceQuery\)[\s\S]*applyDept\(payHistQuery\)[\s\S]*applyDept\(creditNoteQuery\)/)
  })
  it("the totals and the Overview list are built from every invoice, not the filtered ones", () => {
    expect(page).toContain("const clientListAll = buildClientList(invoiceSummary, false)")
    expect(page).toContain("clientCount: clientListAll.filter")
  })
  it("a broken catalog is caught and the screen falls back to showing everything", () => {
    expect(page).toMatch(/catch \(e\) \{\s*console\.error\('\[finance\] invoice departments unavailable/)
  })
  it("a failed slice of the all-invoices read stops the screen instead of leaving totals short", () => {
    expect(page).toMatch(/if \(pageError\) throw new Error/)
  })
  it("a selected client hidden by the switch gets a message, not the plain prompt", () => {
    const tab = readFileSync("app/(dashboard)/finance/clients-invoices-tab.tsx", "utf8")
    expect(tab).toContain("No invoices for this client here")
  })
  it("the all-invoices read pages through 1000-row slices", () => {
    expect(page).toContain(".range(from, from + 999)")
  })
  it("picking a client in By Client keeps the department in the address", () => {
    const tab = readFileSync("app/(dashboard)/finance/clients-invoices-tab.tsx", "utf8")
    expect(tab).toContain("searchParams.get('dept')")
    expect(tab).toMatch(/router\.push\(`\/finance\?tab=clients&client=\$\{id\}\$\{dept \?/)
  })
})
