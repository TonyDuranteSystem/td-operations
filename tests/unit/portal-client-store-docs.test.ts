import { describe, it, expect, vi } from "vitest"
import { dropStoreRowsClientCannotOpen, clientMayOpen, shownToClientByRow, type ClientStoreDeps } from "@/lib/portal/client-store-docs"

const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"
const C = "33333333-3333-3333-3333-333333333333"
const store = (id: string) => `store:${id}`

function deps(over: Partial<ClientStoreDeps> = {}): ClientStoreDeps {
  return {
    serviceTypes: async () => new Map(),
    closed: async () => new Set(),
    personalOutsidePerson: async () => new Set(),
    ...over,
  }
}

describe("shownToClientByRow — the one rule for the list AND the download", () => {
  it("a document marked visible is shown", () => {
    expect(shownToClientByRow({ portalVisible: true, serviceType: null, flowStage: null })).toBe(true)
  })
  it("a flow document at a client-safe stage is shown even though its flag is off (the 'listed but 404' case)", () => {
    expect(shownToClientByRow({ portalVisible: false, serviceType: "Company Formation", flowStage: "EIN Received" })).toBe(true)
    expect(shownToClientByRow({ portalVisible: null, serviceType: "Tax Return", flowStage: "Signed" })).toBe(true)
  })
  it("an internal flow document (the unsigned prepared return) and an unknown stage are NOT shown", () => {
    expect(shownToClientByRow({ portalVisible: false, serviceType: "Tax Return", flowStage: "Tax Return Prepared" })).toBe(false)
    expect(shownToClientByRow({ portalVisible: false, serviceType: "Unknown", flowStage: "X" })).toBe(false)
    expect(shownToClientByRow({ portalVisible: false, serviceType: null, flowStage: null })).toBe(false)
  })
})

describe("dropStoreRowsClientCannotOpen — only rows in the NEW storage are ever touched", () => {
  it("returns Drive and old-bucket rows untouched and makes NO lookups when nothing is in the new storage", async () => {
    const d = deps({ closed: vi.fn(async () => new Set<string>()), serviceTypes: vi.fn(async () => new Map<string, string | null>()) })
    const rows = [
      { id: "1", drive_file_id: "1AbCdEfDriveId", portal_visible: false },
      { id: "2", drive_file_id: "storage:uploads/x.pdf", portal_visible: false },
      { id: "3", drive_file_id: null },
    ]
    expect(await dropStoreRowsClientCannotOpen(rows, {}, d)).toEqual(rows)
    expect(d.closed).not.toHaveBeenCalled()
    expect(d.serviceTypes).not.toHaveBeenCalled()
  })

  it("keeps a visible store row, drops a hidden one", async () => {
    const rows = [
      { id: "vis", drive_file_id: store(A), portal_visible: true },
      { id: "hid", drive_file_id: store(B), portal_visible: false },
    ]
    const out = await dropStoreRowsClientCannotOpen(rows, {}, deps())
    expect(out.map((r) => r.id)).toEqual(["vis"])
  })

  it("keeps a hidden store row that is a client-safe flow document (looked up from its service delivery)", async () => {
    const rows = [{ id: "flow", drive_file_id: store(A), portal_visible: false, service_delivery_id: "sd1", flow_stage: "EIN Received" }]
    const serviceTypes = vi.fn(async () => new Map([["sd1", "Company Formation"]]))
    const out = await dropStoreRowsClientCannotOpen(rows, {}, deps({ serviceTypes }))
    expect(out).toHaveLength(1)
    expect(serviceTypes).toHaveBeenCalledWith(["sd1"])
  })

  it("drops a store row whose file is closed (untyped / staff-only) even if the CRM row is visible", async () => {
    const rows = [{ id: "u", drive_file_id: store(A), portal_visible: true }, { id: "ok", drive_file_id: store(B), portal_visible: true }]
    const out = await dropStoreRowsClientCannotOpen(rows, {}, deps({ closed: async () => new Set([store(A)]) }))
    expect(out.map((r) => r.id)).toEqual(["ok"])
  })

  it("drops a personal document (passport) filed outside a person's own storage", async () => {
    const rows = [{ id: "pass", drive_file_id: store(C), portal_visible: true }]
    const out = await dropStoreRowsClientCannotOpen(rows, {}, deps({ personalOutsidePerson: async () => new Set([store(C)]) }))
    expect(out).toEqual([])
  })

  it("applyRowRule:false (the documents list, already filtered by the row) still applies the stored-file checks", async () => {
    const rows = [{ id: "a", drive_file_id: store(A) }, { id: "b", drive_file_id: store(B) }]
    const serviceTypes = vi.fn(async () => new Map<string, string | null>())
    const out = await dropStoreRowsClientCannotOpen(rows, { applyRowRule: false }, deps({ serviceTypes, closed: async () => new Set([store(B)]) }))
    expect(out.map((r) => r.id)).toEqual(["a"])
    expect(serviceTypes).not.toHaveBeenCalled()
  })

  it("keeps Drive rows next to store rows (a company with both)", async () => {
    const rows = [
      { id: "drive", drive_file_id: "1AbCdEfDriveId", portal_visible: false },
      { id: "store-hidden", drive_file_id: store(A), portal_visible: false },
    ]
    const out = await dropStoreRowsClientCannotOpen(rows, {}, deps())
    expect(out.map((r) => r.id)).toEqual(["drive"])
  })

  it("a lookup error is never read as 'allowed' (fails closed — the error propagates to the caller)", async () => {
    const rows = [{ id: "x", drive_file_id: store(A), portal_visible: false, service_delivery_id: "sd1", flow_stage: "Signed" }]
    await expect(dropStoreRowsClientCannotOpen(rows, {}, deps({ serviceTypes: async () => { throw new Error("db down") } }))).rejects.toThrow("db down")
  })
})

describe("clientMayOpen — the download route's question", () => {
  it("true for a visible, open store file; false for a hidden one; true for any non-store row", async () => {
    expect(await clientMayOpen({ id: "1", drive_file_id: store(A), portal_visible: true }, deps())).toBe(true)
    expect(await clientMayOpen({ id: "2", drive_file_id: store(A), portal_visible: false }, deps())).toBe(false)
    expect(await clientMayOpen({ id: "3", drive_file_id: "1DriveId", portal_visible: false }, deps())).toBe(true)
  })
})
