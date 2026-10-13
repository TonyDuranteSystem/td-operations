import { describe, it, expect } from "vitest"
import { buildGoLiveReport, mapRows, type CrmDocRow } from "@/lib/crm-store/go-live"

const row = (o: Partial<CrmDocRow> & { id: string }): CrmDocRow => ({
  drive_file_id: `drive-${o.id}`, file_name: `${o.id}.pdf`, contact_id: null, portal_visible: false,
  service_delivery_id: null, flow_stage: null, created_at: "2026-10-01T00:00:00Z", ...o,
})
const COPY = "2026-09-20T00:00:00Z"

describe("brought in: what the client sees, and what the CRM made after the approved copy", () => {
  it("a hidden NEWER unmapped record is brought in; a hidden OLDER one stays on Drive (Antonio decided to leave it)", () => {
    const v = mapRows([row({ id: "new", created_at: "2026-10-05T00:00:00Z" }), row({ id: "old", created_at: "2026-09-01T00:00:00Z" })], [], new Map(), () => null, COPY)
    const by = Object.fromEntries(v.map((x) => [x.rowId, x]))
    expect(by.new.action).toBe("catchup")
    expect(by.old.action).toBe("leave")
  })
  it("a record the CLIENT SEES with no stored copy is brought in, even an old one", () => {
    const v = mapRows([row({ id: "seen", portal_visible: true, created_at: "2025-01-01T00:00:00Z" })], [], new Map(), () => null, COPY)
    expect(v[0]).toMatchObject({ action: "catchup", clientSees: true })
    expect(v[0].reason).toMatch(/client sees it/)
  })
  it("a record the client sees that DOES have a stored copy (exact or same bytes) is pointed at storage, not brought in again", () => {
    const exact = mapRows([row({ id: "n", portal_visible: true })], [{ sourceId: "drive-n", storeFileId: "F", md5: null, size: 1 }], new Map(), () => null, COPY)
    expect(exact[0].action).toBe("repoint")
    const twin = mapRows([row({ id: "t", portal_visible: true })], [{ sourceId: "other", storeFileId: "F2", md5: "m", size: 1 }], new Map([["t", { sourceId: "other", storeFileId: "F2", md5: "m", size: 1 }]]), () => null, COPY)
    expect(twin[0]).toMatchObject({ action: "repoint", via: "twin" })
  })
  it("an SS-4 record (not a Drive file) can never be brought in", () => {
    const v = mapRows([row({ id: "s", drive_file_id: "ss4-live:abc", portal_visible: true })], [], new Map(), () => null, COPY)
    expect(v[0].action).toBe("leave")
  })
  it("a person's own record that IS in the copy is linked to the person's stored file", () => {
    const v = mapRows([row({ id: "pp", contact_id: "c1" })], [{ sourceId: "drive-pp", storeFileId: "PF", md5: null, size: 1 }], new Map(), () => null, COPY)
    expect(v[0]).toMatchObject({ action: "repoint", via: "exact", storeFileId: "PF" })
  })
  it("a hidden person's record is never brought in; one the client sees is", () => {
    const hidden = mapRows([row({ id: "p", contact_id: "c1", created_at: "2026-10-05T00:00:00Z" })], [], new Map(), () => null, COPY)
    expect(hidden[0].action).toBe("leave")
    const seen = mapRows([row({ id: "q", contact_id: "c1", portal_visible: true })], [], new Map(), () => null, COPY)
    expect(seen[0].action).toBe("catchup")
  })
  it("with no copy date, only records the client sees are brought in", () => {
    const v = mapRows([row({ id: "x", created_at: "2026-10-05T00:00:00Z" }), row({ id: "y", portal_visible: true })], [], new Map(), () => null, null)
    expect(v.map((x) => x.action)).toEqual(["leave", "catchup"])
  })
  it("the report counts brought-in records separately from records left on Drive", () => {
    const rows = [row({ id: "new", created_at: "2026-10-05T00:00:00Z" }), row({ id: "old", created_at: "2026-09-01T00:00:00Z" })]
    const r = buildGoLiveReport("a", [], rows, mapRows(rows, [], new Map(), () => null, COPY))
    expect(r.rows).toMatchObject({ total: 2, catchUp: 1, leftOnDrive: 1 })
  })
})
