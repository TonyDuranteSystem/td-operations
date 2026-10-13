import { describe, it, expect } from "vitest"
import { buildGoLiveReport, goLiveAllowed, goLiveBlockers, mapRows, mustStayOnDrive, type CrmDocRow, type LedgerFile } from "@/lib/crm-store/go-live"

const row = (o: Partial<CrmDocRow> & { id: string }): CrmDocRow => ({
  drive_file_id: `drive-${o.id}`, file_name: `${o.id}.pdf`, contact_id: null, portal_visible: false,
  service_delivery_id: null, flow_stage: null, created_at: "2026-01-01T00:00:00Z", ...o,
})
const file = (sourceId: string, storeFileId: string): LedgerFile => ({ sourceId, storeFileId, md5: "m", size: 10 })
const none = () => null

describe("goLiveBlockers", () => {
  const ok = { excluded: false, ownerCount: 1, ownerIsStudy: true, hasDoneCopy: true, openMoveRun: false, openSigning: false, state: "drive" as const }
  it("a normal reviewed company may switch", () => expect(goLiveBlockers(ok)).toEqual([]))
  it("blocks closed/test, no copy, unfinished copy, open move, open signing, already switched, two storages", () => {
    expect(goLiveBlockers({ ...ok, excluded: true })).toHaveLength(1)
    expect(goLiveBlockers({ ...ok, ownerCount: 0, ownerIsStudy: false, hasDoneCopy: false }).join(" ")).toMatch(/no reviewed copy/)
    expect(goLiveBlockers({ ...ok, hasDoneCopy: false }).join(" ")).toMatch(/never finished/)
    expect(goLiveBlockers({ ...ok, openMoveRun: true, state: "moving" }).join(" ")).toMatch(/already open/)
    expect(goLiveBlockers({ ...ok, openSigning: true }).join(" ")).toMatch(/signing/)
    expect(goLiveBlockers({ ...ok, state: "store", ownerIsStudy: false }).join(" ")).toMatch(/already in the new storage/)
    expect(goLiveBlockers({ ...ok, ownerCount: 2 }).join(" ")).toMatch(/more than one storage/)
  })
})

describe("mapRows", () => {
  it("maps an exact match, leaves what is not in the copy, skips person rows and rows already in storage", () => {
    const v = mapRows(
      [row({ id: "a" }), row({ id: "b" }), row({ id: "c", contact_id: "p1" }), row({ id: "d", drive_file_id: "store:xyz" }), row({ id: "e", drive_file_id: "storage:old/path" })],
      [file("drive-a", "F1")], new Map(), none,
    )
    const by = Object.fromEntries(v.map((x) => [x.rowId, x]))
    expect(by.a).toMatchObject({ action: "repoint", via: "exact", storeFileId: "F1" })
    expect(by.b).toMatchObject({ action: "leave", reason: expect.stringMatching(/not in the approved copy/) })
    expect(by.c).toMatchObject({ action: "leave", reason: expect.stringMatching(/not in the approved copy/) })
    expect(by.d.action).toBe("leave")
    expect(by.e.action).toBe("leave")
  })

  it("a twin (same bytes, different Drive file) is linked", () => {
    const v = mapRows([row({ id: "t", drive_file_id: "other-drive-id" })], [file("drive-a", "F1")], new Map([["t", file("drive-a", "F1")]]), none)
    expect(v[0]).toMatchObject({ action: "repoint", via: "twin", storeFileId: "F1" })
  })

  it("one record per stored file: the record the client sees wins over a hidden exact one", () => {
    const hiddenExact = row({ id: "h", drive_file_id: "drive-a", portal_visible: false })
    const visibleTwin = row({ id: "v", drive_file_id: "drive-twin", portal_visible: true })
    const v = mapRows([hiddenExact, visibleTwin], [file("drive-a", "F1")], new Map([["v", file("drive-a", "F1")]]), none)
    const by = Object.fromEntries(v.map((x) => [x.rowId, x]))
    expect(by.v).toMatchObject({ action: "repoint", clientSees: true })
    expect(by.h.action).toBe("leave")
    expect(by.h.reason).toMatch(/second record/)
  })

  it("two records equally ranked: exact beats twin; then the older one", () => {
    const a = row({ id: "a", drive_file_id: "drive-a", created_at: "2026-02-01T00:00:00Z" })
    const b = row({ id: "b", drive_file_id: "drive-b", created_at: "2026-01-01T00:00:00Z" })
    const v = mapRows([a, b], [file("drive-a", "F1")], new Map([["b", file("drive-a", "F1")]]), none)
    expect(Object.fromEntries(v.map((x) => [x.rowId, x.action]))).toEqual({ a: "repoint", b: "leave" })
  })

  it("a flow document at a client-safe stage counts as seen by the client", () => {
    const v = mapRows([row({ id: "f", drive_file_id: "drive-f", service_delivery_id: "sd1", flow_stage: "x", portal_visible: false })], [file("drive-f", "F9")], new Map(), () => "Some Service")
    expect(typeof v[0].clientSees).toBe("boolean")
  })
})

describe("report + holds", () => {
  it("counts and lists what the client sees that stays on Drive", () => {
    const rows = [row({ id: "a", portal_visible: true }), row({ id: "b", portal_visible: true }), row({ id: "c" })]
    const v = mapRows(rows, [file("drive-a", "F1")], new Map(), none)
    const r = buildGoLiveReport("acc", [], rows, v)
    expect(r.mayGoLive).toBe(true)
    // 'b' is seen by the client with no stored copy → brought in (not left on Drive); only the hidden old 'c' stays
    expect(r.rows).toMatchObject({ total: 3, exact: 1, twin: 0, catchUp: 1, leftOnDrive: 1, clientSeesTotal: 2, clientSeesLeftOnDrive: 0 })
    expect(r.clientStillOnDrive).toEqual([])
  })
  it("mustStayOnDrive only for records the client sees that storage would hide", () => {
    expect(mustStayOnDrive({ clientSees: true, closedToClients: true, personalOutsidePerson: false })).toBe(true)
    expect(mustStayOnDrive({ clientSees: true, closedToClients: false, personalOutsidePerson: true })).toBe(true)
    expect(mustStayOnDrive({ clientSees: false, closedToClients: true, personalOutsidePerson: false })).toBe(false)
    expect(mustStayOnDrive({ clientSees: true, closedToClients: false, personalOutsidePerson: false })).toBe(false)
  })
  it("is off unless STORE_GO_LIVE=1", () => {
    expect(goLiveAllowed({})).toBe(false)
    expect(goLiveAllowed({ STORE_GO_LIVE: "1" })).toBe(true)
  })
})
