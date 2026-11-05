/**
 * Invoice departments (dev job ac893719): the catalog rules, the "store only a non-default department" rule, and that a paid TD Marketing call stamps the
 * department on BOTH the invoice and its credit note. The catalog is faked; no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const DEFAULT_ID = "11111111-1111-1111-1111-111111111111"
const MARKETING_ID = "22222222-2222-2222-2222-222222222222"

const td = (over: Record<string, unknown> = {}) => ({ id: DEFAULT_ID, slug: "td_clients", display_name: "TD clients", status: "active", created_at: "2026-11-05T10:00:00Z", metadata: { is_default: true, origins: [], sort_order: 10 }, ...over })
const mk = (over: Record<string, unknown> = {}) => ({ id: MARKETING_ID, slug: "td_marketing", display_name: "TD Marketing", status: "active", created_at: "2026-11-05T10:00:01Z", metadata: { origins: ["marketing_sale"], sort_order: 20 }, ...over })

let catalog: unknown[] = []
const listEntries = vi.fn(async () => catalog)
vi.mock("@/lib/catalog/framework", () => ({ listEntries: (...a: unknown[]) => (listEntries as unknown as (...x: unknown[]) => unknown)(...a) }))

import {
  DepartmentConfigError, INVOICE_ORIGINS, departmentFields, departmentIdToStore, departmentIdToStoreForOrigin, departmentsForSwitches,
  getDefaultDepartment, pickDefaultDepartment, pickDepartmentForOrigin,
} from "@/lib/invoices/departments"

beforeEach(() => { catalog = [td(), mk()]; listEntries.mockClear() })

describe("the default department", () => {
  it("is the one flagged is_default", () => {
    expect(pickDefaultDepartment([mk(), td()] as never).slug).toBe("td_clients")
  })
  it("zero defaults fails loud", () => {
    expect(() => pickDefaultDepartment([mk()] as never)).toThrow(DepartmentConfigError)
  })
  it("two defaults fails loud and names both", () => {
    const two = [td(), mk({ metadata: { is_default: true, origins: ["marketing_sale"] } })]
    expect(() => pickDefaultDepartment(two as never)).toThrow(/2 invoice departments.*td_clients, td_marketing/)
  })
  it("a RETIRED default is still the default (invoices with nothing stored keep belonging to it)", () => {
    expect(pickDefaultDepartment([td({ status: "deprecated" }), mk()] as never).id).toBe(DEFAULT_ID)
  })
  it("a flag that is not the boolean true is ignored (a string 'true' is not a default)", () => {
    expect(() => pickDefaultDepartment([td({ metadata: { is_default: "true" } }), mk()] as never)).toThrow(DepartmentConfigError)
  })
})

describe("the department that owns an origin", () => {
  it("TD Marketing owns marketing_sale", () => {
    expect(pickDepartmentForOrigin([td(), mk()] as never, INVOICE_ORIGINS.marketingSale).slug).toBe("td_marketing")
  })
  it("an origin nobody owns fails loud (it must never fall back to the default silently)", () => {
    expect(() => pickDepartmentForOrigin([td(), mk()] as never, "something_else")).toThrow(/no active invoice department owns the origin "something_else"/)
  })
  it("a RETIRED owner does not count", () => {
    expect(() => pickDepartmentForOrigin([td(), mk({ status: "deprecated" })] as never, "marketing_sale")).toThrow(DepartmentConfigError)
  })
  it("two owners of one origin fail loud (a default department that ALSO lists the origin must not win silently)", () => {
    const alsoOnDefault = td({ metadata: { is_default: true, origins: ["marketing_sale"] } })
    expect(() => pickDepartmentForOrigin([alsoOnDefault, mk()] as never, "marketing_sale")).toThrow(/2 active invoice departments claim the origin "marketing_sale" \(td_clients, td_marketing\)/)
    expect(() => departmentIdToStore([mk(), alsoOnDefault] as never, "marketing_sale")).toThrow(DepartmentConfigError)
  })
  it("malformed metadata (no origins, an origins that is not a list) owns nothing and does not crash", () => {
    expect(() => pickDepartmentForOrigin([td(), mk({ metadata: { origins: "marketing_sale" } })] as never, "marketing_sale")).toThrow(DepartmentConfigError)
    expect(() => pickDepartmentForOrigin([td(), mk({ metadata: null })] as never, "marketing_sale")).toThrow(DepartmentConfigError)
  })
})

describe("what is stored on an invoice", () => {
  it("a non-default owner is stored", () => {
    expect(departmentIdToStore([td(), mk()] as never, "marketing_sale")).toBe(MARKETING_ID)
  })
  it("when the owner IS the default, nothing is stored (null)", () => {
    const tdOwnsIt = [td({ metadata: { is_default: true, origins: ["marketing_sale"] } }), mk({ metadata: { origins: [] } })]
    expect(departmentIdToStore(tdOwnsIt as never, "marketing_sale")).toBeNull()
  })
  it("departmentFields names the column only when there is a department", () => {
    expect(departmentFields(MARKETING_ID)).toEqual({ department_entry_id: MARKETING_ID })
    expect(departmentFields(null)).toEqual({})
    expect(departmentFields(undefined)).toEqual({})
    expect("department_entry_id" in departmentFields("")).toBe(false)
  })
})

describe("reading the catalog", () => {
  it("asks for every status, and does not remember an answer (a catalog edit is seen at once)", async () => {
    expect(await departmentIdToStoreForOrigin("marketing_sale")).toBe(MARKETING_ID)
    catalog = [td(), mk({ status: "deprecated" })]
    await expect(departmentIdToStoreForOrigin("marketing_sale")).rejects.toThrow(DepartmentConfigError)
    expect(listEntries).toHaveBeenCalledTimes(2)
    expect(listEntries).toHaveBeenCalledWith("invoice_departments", { includeDeprecated: true })
  })
  it("a broken catalog is an error, never a silent default", async () => {
    catalog = []
    await expect(getDefaultDepartment()).rejects.toThrow(DepartmentConfigError)
  })
})

describe("the switches", () => {
  it("lists active departments in sort order", () => {
    expect(departmentsForSwitches([mk(), td()] as never).map(e => e.slug)).toEqual(["td_clients", "td_marketing"])
  })
  it("a retired department is listed only while an invoice still points at it", () => {
    const retired = mk({ status: "deprecated" })
    expect(departmentsForSwitches([td(), retired] as never).map(e => e.slug)).toEqual(["td_clients"])
    expect(departmentsForSwitches([td(), retired] as never, new Set([MARKETING_ID])).map(e => e.slug)).toEqual(["td_clients", "td_marketing"])
  })
})

// ───────── a paid TD Marketing call stamps the invoice AND its credit note ─────────
const createTDInvoice = vi.fn()
// What the fake database was asked to do: every update with the filters that came with it, and what a read for an activated credit answers.
type Write = { payload: Record<string, unknown>; ids?: unknown; isNull?: string }
let writes: Write[] = []
let activatedRow: unknown = null
let deptWriteError: { message: string } | null = null
function builder() {
  let payload: Record<string, unknown> | null = null
  const rec: Write = { payload: {} }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b, eq: () => b, neq: () => b, limit: () => b,
    update: (p: Record<string, unknown>) => { payload = p; rec.payload = p; return b },
    in: (_col: string, ids: unknown) => { rec.ids = ids; return b },
    is: (col: string) => { rec.isNull = col; return b },
    maybeSingle: () => Promise.resolve({ data: activatedRow, error: null }),
    then: (res: (v: unknown) => unknown) => {
      if (payload) writes.push(rec)
      const error = payload && "department_entry_id" in payload ? deptWriteError : null
      return Promise.resolve({ data: null, error }).then(res)
    },
  }
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => builder() } }))
vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: (...a: unknown[]) => createTDInvoice(...a) }))
vi.mock("@/lib/stripe-sync", () => ({ paymentIntentIdForCharge: vi.fn(async () => null) }))
vi.mock("@/lib/operations/credit-subject", () => ({
  resolveCreditSubject: vi.fn(async () => ({ kind: "resolved", contactId: "c1", email: "a@b.c" })),
  subjectForRecording: () => ({ contactId: "c1", ambiguous: false }),
}))
import { recordPaidCall } from "@/lib/operations/paid-call-credit"

const params = {
  payment: { chargeId: "stripe-session:cs_x", amount: 397, currency: "EUR" as const, provider: "stripe", paymentIntentId: "pi_1" },
  inviteeEmail: "a@b.c",
  manual: { feedId: "stripe-session:cs_x", sourceLabel: "Stripe payment (TD Marketing link)" },
}

describe("recordPaidCall + department", () => {
  beforeEach(() => {
    writes = []; activatedRow = null; deptWriteError = null
    createTDInvoice.mockReset()
    createTDInvoice
      .mockResolvedValueOnce({ paymentId: "p-inv", invoiceNumber: "INV-1", expenseId: "", total: 397, status: "Paid" })
      .mockResolvedValueOnce({ paymentId: "p-cr", invoiceNumber: "CN-1", expenseId: "", total: -397, status: "Draft" })
  })
  it("passes the department to BOTH the invoice and the credit note", async () => {
    await recordPaidCall({ ...params, departmentEntryId: MARKETING_ID })
    expect(createTDInvoice).toHaveBeenCalledTimes(2)
    expect(createTDInvoice.mock.calls[0][0].idempotency_key).toMatch(/:invoice$/)
    expect(createTDInvoice.mock.calls[1][0].idempotency_key).toMatch(/:credit$/)
    expect(createTDInvoice.mock.calls[0][0].department_entry_id).toBe(MARKETING_ID)
    expect(createTDInvoice.mock.calls[1][0].department_entry_id).toBe(MARKETING_ID)
  })
  const deptWrites = () => writes.filter(w => "department_entry_id" in w.payload)
  it("rows that ALREADY existed (a person confirmed the same Stripe payment by hand first) are stamped too, and only where nothing is stored yet", async () => {
    await recordPaidCall({ ...params, departmentEntryId: MARKETING_ID })
    expect(deptWrites()).toHaveLength(1)
    expect(deptWrites()[0].payload).toEqual({ department_entry_id: MARKETING_ID })
    expect(deptWrites()[0].ids).toEqual(["p-inv", "p-cr"])
    expect(deptWrites()[0].isNull).toBe("department_entry_id")
  })
  it("an activated credit reused on a redelivery is stamped as well (createTDInvoice is not called for it)", async () => {
    activatedRow = { id: "p-cr-old", invoice_number: "CN-9" }
    createTDInvoice.mockReset()
    createTDInvoice.mockResolvedValueOnce({ paymentId: "p-inv", invoiceNumber: "INV-1", expenseId: "", total: 397, status: "Paid" })
    const r = await recordPaidCall({ ...params, departmentEntryId: MARKETING_ID })
    expect(createTDInvoice).toHaveBeenCalledTimes(1)
    expect(r.creditId).toBe("p-cr-old")
    expect(deptWrites()[0].ids).toEqual(["p-inv", "p-cr-old"])
  })
  it("a failed stamp is an error (the settle step then waits and retries), never a silent unstamped marketing invoice", async () => {
    deptWriteError = { message: "boom" }
    await expect(recordPaidCall({ ...params, departmentEntryId: MARKETING_ID })).rejects.toThrow(/could not file the invoice and credit note under their department: boom/)
  })
  it("no department: nothing is written about departments", async () => {
    await recordPaidCall(params)
    expect(deptWrites()).toHaveLength(0)
  })
  it("without a department (every other paid call: Calendly, bank attach) neither row names the column", async () => {
    await recordPaidCall(params)
    expect("department_entry_id" in createTDInvoice.mock.calls[0][0]).toBe(false)
    expect("department_entry_id" in createTDInvoice.mock.calls[1][0]).toBe(false)
  })
})

// ───────── the one writer of a marketing invoice must keep asking for the department ─────────
import { readFileSync } from "node:fs"
describe("guard: the TD Marketing settle step cannot forget the department", () => {
  const src = readFileSync("lib/finance/marketing-sale-settle.ts", "utf8")
  const lookup = src.indexOf("departmentIdToStoreForOrigin(INVOICE_ORIGINS.marketingSale)")
  const call = src.indexOf("recordPaidCall({")
  it("asks the catalog which department owns a marketing sale (never a hardcoded name), BEFORE it creates anything", () => {
    expect(lookup).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(lookup)
    expect(src).not.toMatch(/td_marketing|td_clients/)
  })
  it("hands the answer to recordPaidCall as the departmentEntryId argument (not null, not elsewhere)", () => {
    const callBody = src.slice(call, src.indexOf("})", call))
    expect(callBody).toMatch(/\n\s+departmentEntryId,\n/)
  })
  it("a catalog problem is caught between the lookup and the creation, and the row WAITS: the try is not counted, so it can never park a paid payment", () => {
    const between = src.slice(lookup, call)
    expect(between).toMatch(/catch \(e\)/)
    expect(between).toMatch(/failTry\([^\n]*\{ count: false \}\)/)
    expect(between).toMatch(/waiting and has not been invoiced yet/)
  })
})
