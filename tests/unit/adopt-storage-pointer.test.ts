import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Stop-Drive S1a (dev job 264bb882): client files parked in the older bucket (storage:flow-uploads/...) are filed into the CRM
 * storage and the SAME documents row is re-pointed. Every Google Drive function is a spy that fails the test if reached.
 */
const driveCalls: string[] = []
vi.mock("@/lib/google-drive", () => {
  const spy = (n: string) => async () => { driveCalls.push(n); throw new Error(`Drive was called: ${n}`) }
  return { listFolder: spy("listFolder"), createFolder: spy("createFolder"), uploadBinaryToDrive: spy("uploadBinaryToDrive"), uploadBinaryToDriveUpsert: spy("uploadBinaryToDriveUpsert"), downloadFileBinary: spy("downloadFileBinary") }
})
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { adoptStoragePointerRow, adoptRows, type AdoptDeps, type AdoptRow } from "@/lib/crm-store/adopt-storage-pointer"
import { resolveArticlesPdf } from "@/lib/ss4/resolve-articles-pdf"
import { pickWelcomeDocs } from "@/lib/operations/welcome-docs"
import { classifyPointer } from "@/lib/documents/open-document"

const ACC = "acc-1", CON = "con-1", SD = "sd-1"
const FILE_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f1"
const row = (over: Partial<AdoptRow> = {}): AdoptRow => ({
  id: "doc-1", drive_file_id: "storage:flow-uploads/sd-1/1_Articles.pdf", file_name: "Articles.pdf", mime_type: "application/pdf",
  account_id: ACC, contact_id: CON, service_delivery_id: SD, flow_stage: "Filed with State", portal_visible: false, document_type_name: null, ...over,
})

let docs: Map<string, { drive_file_id: string; document_type_name: string | null; portal_visible: boolean | null }>
const saved: Array<Record<string, unknown>> = []
const alarms: Array<[string, Record<string, unknown>]> = []
const mk = (over: Partial<AdoptDeps> = {}): AdoptDeps => ({
  serviceTypeOf: async () => "Company Formation",
  companyState: async () => "store",
  liveOwnerOfAccount: async () => "acc-owner",
  liveOwnerOfContact: async () => "person-owner",
  formationOwnerOfCase: async () => null,
  download: async () => ({ bytes: Buffer.from("%PDF"), mimeType: "application/pdf" }),
  save: async (p) => { saved.push(p as unknown as Record<string, unknown>); return { fileId: FILE_ID, status: "created" } },
  typeLabelOf: async (slug) => (slug === "articles_of_organization" ? "Articles of Organization" : null),
  repoint: async (id, oldP, newP, _l, label, published) => {
    const d = docs.get(id)!
    if (d.drive_file_id !== oldP) return false
    d.drive_file_id = newP; if (label) d.document_type_name = label; d.portal_visible = published
    return true
  },
  pointer: (id) => `store:${id}`,
  link: (id) => `/api/documents/${id}/preview`,
  alarm: async (reason, details) => { alarms.push([reason, details]) },
  ...over,
})
beforeEach(() => {
  driveCalls.length = 0; saved.length = 0; alarms.length = 0
  docs = new Map([["doc-1", { drive_file_id: "storage:flow-uploads/sd-1/1_Articles.pdf", document_type_name: null, portal_visible: false }]])
})

describe("adoptStoragePointerRow", () => {
  it("Articles of a company in the storage: filed in 1. Company with the right type, staff-only, SAME record re-pointed, 0 Drive calls", async () => {
    const r = await adoptStoragePointerRow(row(), mk())
    expect(r).toEqual({ status: "adopted", pointer: `store:${FILE_ID}`, where: "company" })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ ownerId: "acc-owner", folderKind: "company", documentType: "articles_of_organization", published: false, callerKey: "adopt-storage:doc-1", name: "Articles.pdf" })
    expect(docs.get("doc-1")).toMatchObject({ drive_file_id: `store:${FILE_ID}`, document_type_name: "Articles of Organization", portal_visible: false })
    expect(driveCalls).toEqual([])
    expect(alarms).toEqual([])
  })
  it("is idempotent: a second run finds a store pointer and does nothing; the same caller key would not make a second file", async () => {
    await adoptStoragePointerRow(row(), mk())
    const again = await adoptStoragePointerRow(row({ drive_file_id: `store:${FILE_ID}` }), mk())
    expect(again).toEqual({ status: "already" })
    expect(saved).toHaveLength(1)
  })
  it("a concurrent run that already re-pointed the row is 'already', not an error", async () => {
    const r = await adoptStoragePointerRow(row(), mk({ repoint: async () => false }))
    expect(r).toEqual({ status: "already" })
    expect(alarms).toEqual([])
  })
  it("a client-visible file (ITIN approval letter) stays visible and never untyped", async () => {
    docs.get("doc-1")!.portal_visible = true
    await adoptStoragePointerRow(row({ account_id: null, service_delivery_id: SD, flow_stage: "ITIN Approved", portal_visible: true }), mk({ serviceTypeOf: async () => "ITIN" }))
    expect(saved[0]).toMatchObject({ ownerId: "person-owner", folderKind: "itin", documentType: "other_document", published: true })
    expect(docs.get("doc-1")!.portal_visible).toBe(true)
  })
  it("an ITIN paper of a person with no ITIN folder falls back to Personal documents", async () => {
    let n = 0
    const save = async (p: unknown) => { n++; if (n === 1) throw new Error('store pilot: owner x has no "itin" folder'); saved.push(p as Record<string, unknown>); return { fileId: FILE_ID, status: "created" } }
    const r = await adoptStoragePointerRow(row({ account_id: null }), mk({ serviceTypeOf: async () => "ITIN", save }))
    expect(r.status).toBe("adopted")
    expect(saved[0]).toMatchObject({ folderKind: "personal" })
  })
  it("a company still on Drive, or mid-move, or a person with no storage: left alone, no alarm", async () => {
    expect(await adoptStoragePointerRow(row(), mk({ companyState: async () => "drive" }))).toMatchObject({ status: "skipped" })
    expect(await adoptStoragePointerRow(row(), mk({ companyState: async () => "moving" }))).toMatchObject({ status: "skipped" })
    expect(await adoptStoragePointerRow(row({ account_id: null }), mk({ serviceTypeOf: async () => "ITIN", liveOwnerOfContact: async () => null }))).toMatchObject({ status: "skipped" })
    expect(saved).toEqual([]); expect(alarms).toEqual([])
    expect(docs.get("doc-1")!.drive_file_id).toContain("storage:flow-uploads/")
  })
  it("a company being formed: only its in-formation storage (never a person's folder)", async () => {
    expect(await adoptStoragePointerRow(row({ account_id: null }), mk())).toMatchObject({ status: "skipped" })
    const r = await adoptStoragePointerRow(row({ account_id: null }), mk({ formationOwnerOfCase: async () => "formation-owner" }))
    expect(r).toMatchObject({ status: "adopted", where: "formation" })
    expect(saved[0]).toMatchObject({ ownerId: "formation-owner", folderKind: "company" })
  })
  it("other storage: shapes (signed-documents, fax-attachments) are not touched", async () => {
    expect(await adoptStoragePointerRow(row({ drive_file_id: "storage:signed-documents/x.pdf" }), mk())).toMatchObject({ status: "skipped" })
    expect(await adoptStoragePointerRow(row({ drive_file_id: "storage:fax-attachments/x.pdf" }), mk())).toMatchObject({ status: "skipped" })
    expect(saved).toEqual([])
  })
  it("FAILURES are never ok: a missing file, a failing save, a missing company storage each give 'failed' + a staff alarm, the old pointer is kept", async () => {
    const a = await adoptStoragePointerRow(row(), mk({ download: async () => null }))
    const b = await adoptStoragePointerRow(row(), mk({ save: async () => { throw new Error("store down") } }))
    const c = await adoptStoragePointerRow(row(), mk({ liveOwnerOfAccount: async () => null }))
    const d = await adoptStoragePointerRow(row(), mk({ repoint: async () => { throw new Error("duplicate key") } }))
    for (const r of [a, b, c, d]) expect(r.status).toBe("failed")
    expect(alarms).toHaveLength(4)
    expect(alarms[0][1]).toMatchObject({ documentId: "doc-1", accountId: ACC })
    expect(docs.get("doc-1")!.drive_file_id).toBe("storage:flow-uploads/sd-1/1_Articles.pdf")
    expect(driveCalls).toEqual([])
  })
})

describe("adoptRows — a batch keeps going and reports each outcome", () => {
  it("counts adopted / already / skipped / failed", async () => {
    docs.set("doc-2", { drive_file_id: "storage:flow-uploads/sd-1/2.pdf", document_type_name: null, portal_visible: false })
    const rows = [row(), row({ id: "doc-2", drive_file_id: "storage:flow-uploads/sd-1/2.pdf" }), row({ id: "doc-3", drive_file_id: `store:${FILE_ID}` }), row({ id: "doc-4", account_id: null, contact_id: null })]
    let n = 0
    const out = await adoptRows(rows, mk({ download: async () => (++n === 2 ? null : { bytes: Buffer.from("x"), mimeType: null }) }))
    expect(out).toMatchObject({ adopted: 1, already: 1 })
    expect(out.failed).toHaveLength(1)
    expect(out.skipped).toHaveLength(1)
  })
})

describe("readers keep finding the file — old storage: pointer AND new store: pointer", () => {
  it("the SS-4 Articles resolver reads both shapes", async () => {
    const bytes = Buffer.from("ARTICLES")
    const deps = (ptr: string) => ({
      findArticlesDoc: async () => ({ drive_file_id: ptr, file_name: "Articles.pdf" }),
      downloadStorage: async () => bytes, downloadDrive: async () => { driveCalls.push("downloadDrive"); return null },
      downloadStore: async (id: string) => (id === FILE_ID ? bytes : null),
    })
    expect(await resolveArticlesPdf(deps("storage:flow-uploads/sd-1/1_Articles.pdf"))).toEqual(bytes)
    expect(await resolveArticlesPdf(deps(`store:${FILE_ID}`))).toEqual(bytes)
    expect(driveCalls).toEqual([])
  })
  it("the welcome package picks the Articles by type and returns whichever pointer the row holds", () => {
    const mkRow = (ptr: string, type: string | null) => ({ drive_file_id: ptr, file_name: "Articles.pdf", document_type_name: type, status: "classified", created_at: "2026-10-18" })
    expect(pickWelcomeDocs([mkRow("storage:flow-uploads/a.pdf", "Articles of Organization")]).articles?.pointer).toBe("storage:flow-uploads/a.pdf")
    expect(pickWelcomeDocs([mkRow(`store:${FILE_ID}`, "Articles of Organization")]).articles?.pointer).toBe(`store:${FILE_ID}`)
    // the untyped old row was invisible to the welcome package; after adoption it carries the type label
    expect(pickWelcomeDocs([mkRow("storage:flow-uploads/a.pdf", null)]).articles).toBeNull()
  })
  it("the document opener classifies both shapes (store first)", () => {
    expect(classifyPointer(`store:${FILE_ID}`)).toBe("store")
    expect(classifyPointer("storage:flow-uploads/a.pdf")).toBe("storage")
  })
})
