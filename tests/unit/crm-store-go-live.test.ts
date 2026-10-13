import { describe, it, expect } from "vitest"
import {
  buildGoLiveReport, filesWithoutRecord, goLiveAllowed, goLiveBlockers, mapRows, planFingerprint,
  type CrmDocRow, type LedgerFile, type StoredFileInfo,
} from "@/lib/crm-store/go-live"

const row = (o: Partial<CrmDocRow> & { id: string }): CrmDocRow => ({
  drive_file_id: `drive-${o.id}`, file_name: `${o.id}.pdf`, contact_id: null, portal_visible: false,
  service_delivery_id: null, flow_stage: null, created_at: "2026-01-01T00:00:00Z", ...o,
})
const file = (sourceId: string, storeFileId: string): LedgerFile => ({ sourceId, storeFileId, md5: "m", size: 10 })
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const sf = (id: string, name = `${id}.pdf`): StoredFileInfo => ({ id, name, typeSlug: "t", typeDisplay: "Type", legacyTypeId: 1, periodYear: 2024, ownerKind: "company", ownerContactId: null, categoryNum: 1, categoryName: "Company", mimeType: "application/pdf", sizeBytes: 10 })
const COPY = "2026-09-20T00:00:00Z"

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

describe("mapRows — the CRM list becomes the stored files", () => {
  it("a record whose Drive file the cleaning kept is reused (re-pointed); one it did not keep is archived", () => {
    const v = mapRows([row({ id: "kept" }), row({ id: "dropped" })], [file("drive-kept", "F1")], COPY)
    const by = Object.fromEntries(v.map((x) => [x.rowId, x]))
    expect(by.kept).toMatchObject({ action: "repoint", storeFileId: "F1" })
    expect(by.dropped.action).toBe("archive")
  })
  it("a visible old record with no stored file is archived too (the stored files are what the client will be shown)", () => {
    const v = mapRows([row({ id: "seen", portal_visible: true })], [], COPY)
    expect(v[0].action).toBe("archive")
  })
  it("one record per stored file: the earliest record of it is reused, a duplicate is archived", () => {
    const a = row({ id: "a", drive_file_id: "d1", created_at: "2026-02-01T00:00:00Z" })
    const b = row({ id: "b", drive_file_id: "d1", created_at: "2026-01-01T00:00:00Z" })
    const v = mapRows([a, b], [file("d1", "F1")], COPY)
    expect(Object.fromEntries(v.map((x) => [x.rowId, x.action]))).toEqual({ a: "archive", b: "repoint" })
  })
  it("a workspace document (found by its stage) keeps pointing at the file over a plain duplicate", () => {
    const plain = row({ id: "p", drive_file_id: "d1", created_at: "2026-01-01T00:00:00Z" })
    const ws = row({ id: "w", drive_file_id: "d1", created_at: "2026-02-01T00:00:00Z", flow_stage: "x", service_delivery_id: "sd" })
    const v = mapRows([plain, ws], [file("d1", "F1")], COPY)
    expect(Object.fromEntries(v.map((x) => [x.rowId, x.action]))).toEqual({ p: "archive", w: "repoint" })
  })
  it("a record made AFTER the approved copy is left exactly as it is", () => {
    const v = mapRows([row({ id: "n", created_at: "2026-10-05T00:00:00Z" })], [], COPY)
    expect(v[0]).toMatchObject({ action: "leave", reason: expect.stringMatching(/after the approved copy/) })
  })
  it("an unmapped workspace document, an SS-4 record and a record already in storage are untouched", () => {
    const v = mapRows([
      row({ id: "ws", flow_stage: "x", service_delivery_id: "sd" }),
      row({ id: "s", drive_file_id: "ss4-live:abc" }),
      row({ id: "st", drive_file_id: `store:${U(7)}` }),
      row({ id: "old", drive_file_id: "storage:a/b" }),
    ], [], COPY)
    expect(v.every((x) => x.action === "leave")).toBe(true)
  })
  it("a person's own record is reused like any other", () => {
    const v = mapRows([row({ id: "pp", contact_id: "c1" })], [file("drive-pp", "PF")], COPY)
    expect(v[0]).toMatchObject({ action: "repoint", storeFileId: "PF" })
  })
  it("a Drive file copied in two runs: the NEWEST copy wins", () => {
    const v = mapRows([row({ id: "r" })], [{ ...file("drive-r", "OLD"), runStartedAt: "2026-09-01T00:00:00Z" }, { ...file("drive-r", "NEW"), runStartedAt: "2026-09-10T00:00:00Z" }], COPY)
    expect(v[0].storeFileId).toBe("NEW")
  })
})

describe("filesWithoutRecord / report / fingerprint", () => {
  it("a stored file no old record covers gets a new record, unless another record already lists it", () => {
    const v = mapRows([row({ id: "kept" })], [file("drive-kept", U(1))], COPY)
    const need = filesWithoutRecord([sf(U(1)), sf(U(2)), sf(U(3))], v, new Set([`store:${U(3)}`]))
    expect(need.map((n) => n.id)).toEqual([U(2)])
  })
  it("the report counts what the list becomes", () => {
    const rows = [row({ id: "kept" }), row({ id: "dropped" }), row({ id: "n", created_at: "2026-10-05T00:00:00Z" })]
    const v = mapRows(rows, [file("drive-kept", U(1))], COPY)
    const stored = [sf(U(1), "F1.pdf"), sf(U(2), "F2.pdf")]
    const r = buildGoLiveReport("acc", [], rows, v, stored, filesWithoutRecord(stored, v, new Set()))
    expect(r.listing).toEqual({ storedFiles: 2, reusedRecords: 1, newRecords: 1, archivedRecords: 1, untouched: 1 })
    expect(r.archived.map((a) => a.name)).toEqual(["dropped.pdf"])
    expect(r.files.find((f) => f.name === "F2.pdf")?.newRecord).toBe(true)
  })
  it("the fingerprint changes when the plan changes", () => {
    const v = mapRows([row({ id: "a" })], [file("drive-a", U(1))], COPY)
    const h1 = planFingerprint(v, [])
    expect(planFingerprint(v, [sf(U(9))])).not.toBe(h1)
    expect(planFingerprint(v, [])).toBe(h1)
  })
  it("is off unless STORE_GO_LIVE=1", () => {
    expect(goLiveAllowed({})).toBe(false)
    expect(goLiveAllowed({ STORE_GO_LIVE: "1" })).toBe(true)
  })
})
