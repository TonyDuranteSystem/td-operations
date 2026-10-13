import { describe, it, expect } from "vitest"
import { buildGoLiveReport, mapRows, type CrmDocRow } from "@/lib/crm-store/go-live"

const row = (o: Partial<CrmDocRow> & { id: string }): CrmDocRow => ({
  drive_file_id: `drive-${o.id}`, file_name: `${o.id}.pdf`, contact_id: null, portal_visible: true,
  service_delivery_id: null, flow_stage: null, created_at: "2026-10-01T00:00:00Z", ...o,
})
const COPY = "2026-09-20T00:00:00Z"

describe("catch-up: records the CRM made after the approved copy", () => {
  it("a newer unmapped record is a catch-up; an older unmapped one stays on Drive (Antonio decided to leave it)", () => {
    const v = mapRows([row({ id: "new", created_at: "2026-10-05T00:00:00Z" }), row({ id: "old", created_at: "2026-09-01T00:00:00Z" })], [], new Map(), () => null, COPY)
    const by = Object.fromEntries(v.map((x) => [x.rowId, x]))
    expect(by.new.action).toBe("catchup")
    expect(by.old.action).toBe("leave")
  })
  it("a newer record that IS in the copy is linked, not caught up", () => {
    const v = mapRows([row({ id: "n", created_at: "2026-10-05T00:00:00Z" })], [{ sourceId: "drive-n", storeFileId: "F", md5: null, size: 1 }], new Map(), () => null, COPY)
    expect(v[0].action).toBe("repoint")
  })
  it("a person's own newer record is never caught up here", () => {
    const v = mapRows([row({ id: "p", contact_id: "c1", created_at: "2026-10-05T00:00:00Z" })], [], new Map(), () => null, COPY)
    expect(v[0].action).toBe("leave")
  })
  it("a person's own record that IS in the copy is linked to the person's stored file", () => {
    const v = mapRows([row({ id: "pp", contact_id: "c1" })], [{ sourceId: "drive-pp", storeFileId: "PF", md5: null, size: 1 }], new Map(), () => null, COPY)
    expect(v[0]).toMatchObject({ action: "repoint", via: "exact", storeFileId: "PF" })
  })
  it("with no copy date nothing is a catch-up", () => {
    const v = mapRows([row({ id: "x", created_at: "2026-10-05T00:00:00Z" })], [], new Map(), () => null, null)
    expect(v[0].action).toBe("leave")
  })
  it("the report counts catch-ups separately from records left on Drive", () => {
    const rows = [row({ id: "new", created_at: "2026-10-05T00:00:00Z" }), row({ id: "old", created_at: "2026-09-01T00:00:00Z" })]
    const r = buildGoLiveReport("a", [], rows, mapRows(rows, [], new Map(), () => null, COPY))
    expect(r.rows).toMatchObject({ total: 2, catchUp: 1, leftOnDrive: 1 })
  })
})
