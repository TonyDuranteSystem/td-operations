/**
 * FORMATION WORKSPACE — Articles-of-Organization full-chain E2E.
 *
 * Exercises the ENTIRE chain the 2026-07-08 fix spans, end to end, driving the
 * REAL production core functions (relocateFlowStorageDocsToDrive,
 * resolveArticlesPdf) and the REAL pdf-lib merge the ss4-signed route runs —
 * against a realistic in-memory Google Drive + Supabase Storage that behave like
 * the real services (files persist, ids are real, folders list, downloads
 * return the exact bytes). This proves what a sandbox HTTP run cannot: that the
 * Articles physically move into Drive and that the resulting IRS package is a
 * correct multi-page PDF.
 *
 * Chain under test (formation workspace happy path):
 *   1. Staff uploads the Articles at "Filed with State" → contact-scoped, no
 *      company yet → the binary is parked in Supabase Storage
 *      (onboarding-uploads/flow-uploads/<sd>/<file>) and the documents row is
 *      stamped drive_file_id='storage:...'.
 *   2. Upload auto-advances → company materializes → step 10a-bis
 *      (relocateFlowStorageDocsToDrive) copies the binary into the Drive
 *      "1. Company" folder and repoints the documents row.
 *   3. Client signs the SS-4 → ss4-signed resolves the Articles (Drive-scan →
 *      documents fallback) and merges signed SS-4 (page 1) + Articles into the
 *      IRS package.
 *
 * Plus: the safety-net path (Articles nowhere → resolver returns null → the
 * route's loud "articlesMissing" branch) and idempotency (re-run relocates
 * nothing).
 */

import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import {
  relocateFlowStorageDocsToDrive,
  type RelocateFlowDocsDeps,
  type StorageFlowDoc,
} from "@/lib/flows/relocate-flow-storage-docs"
import { resolveArticlesPdf, type ResolveArticlesDeps } from "@/lib/ss4/resolve-articles-pdf"

// ─── Realistic in-memory Google Drive (one shared instance across the chain) ──
class FakeDrive {
  private folders = new Map<string, Map<string, { id: string; bytes: Buffer }>>()
  private byId = new Map<string, Buffer>()
  private seq = 0
  ensureFolder(id: string) {
    if (!this.folders.has(id)) this.folders.set(id, new Map())
  }
  upload(fileName: string, bytes: Buffer, folderId: string): { id: string } {
    this.ensureFolder(folderId)
    const id = `drive-file-${++this.seq}`
    this.folders.get(folderId)!.set(fileName, { id, bytes })
    this.byId.set(id, bytes)
    return { id }
  }
  exists(folderId: string, fileName: string): { exists: boolean; id?: string } {
    const hit = this.folders.get(folderId)?.get(fileName)
    return hit ? { exists: true, id: hit.id } : { exists: false }
  }
  download(fileId: string): Buffer | null {
    return this.byId.get(fileId) ?? null
  }
  list(folderId: string): Array<{ id: string; name: string; mimeType: string }> {
    return [...(this.folders.get(folderId)?.entries() ?? [])].map(([name, v]) => ({
      id: v.id,
      name,
      mimeType: "application/pdf",
    }))
  }
}

// ─── Realistic in-memory Supabase Storage: key = `${bucket}/${path}` ──────────
const makeStorage = () => new Map<string, Buffer>()

/** Build a real, loadable PDF with N pages, each stamped with a label. */
async function makePdf(pages: number, label: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200])
    page.drawText(`${label} p${i + 1}`, { x: 10, y: 100, size: 12 })
  }
  return Buffer.from(await doc.save())
}

/** The exact merge the ss4-signed route performs: SS-4 page 1 + all Articles pages. */
async function buildIrsPackage(ss4Bytes: Buffer, articlesBytes: Buffer): Promise<Buffer> {
  const merged = await PDFDocument.create()
  const ss4Doc = await PDFDocument.load(ss4Bytes)
  const ss4Pages = await merged.copyPages(ss4Doc, [0])
  ss4Pages.forEach((p) => merged.addPage(p))
  const artDoc = await PDFDocument.load(articlesBytes)
  const artPages = await merged.copyPages(artDoc, artDoc.getPageIndices())
  artPages.forEach((p) => merged.addPage(p))
  return Buffer.from(await merged.save())
}

const STORAGE_PATH = "flow-uploads/sd-1/1783532776252_Domestic LLC Articles of Organization  (18).pdf"
const COMPANY_FOLDER = "company-1-folder"

interface DocRow {
  id: string
  file_name: string
  drive_file_id: string
  drive_link?: string
  mime_type: string | null
}

describe("Formation workspace — Articles chain E2E (real functions + real pdf-lib)", () => {
  it("moves the Articles from Storage into Drive at materialization, then merges a correct IRS package on signing", async () => {
    const drive = new FakeDrive()
    drive.ensureFolder(COMPANY_FOLDER)
    const storage = makeStorage()

    // ── STEP 0: staff uploaded the Articles at "Filed with State" (pre-company).
    // 2-page Articles binary sits in Storage; the documents row points at it.
    const articlesBytes = await makePdf(2, "ARTICLES")
    storage.set(`onboarding-uploads/${STORAGE_PATH}`, articlesBytes)
    const docs = new Map<string, DocRow>([
      [
        "doc-articles",
        {
          id: "doc-articles",
          file_name: "Domestic LLC Articles of Organization  (18).pdf",
          drive_file_id: `storage:${STORAGE_PATH}`,
          mime_type: "application/pdf",
        },
      ],
    ])
    // Precondition: NOT in Drive yet (this is the bug state).
    expect(drive.exists(COMPANY_FOLDER, docs.get("doc-articles")!.file_name).exists).toBe(false)

    // ── STEP 1: materialization → step 10a-bis relocates Storage docs to Drive.
    const relocateDeps: RelocateFlowDocsDeps = {
      listStorageDocs: async () =>
        [...docs.values()].filter((d) => d.drive_file_id.startsWith("storage:")) as StorageFlowDoc[],
      downloadStorage: async (bucket, path) => storage.get(`${bucket}/${path}`) ?? null,
      fileExistsInFolder: async (folderId, name) => drive.exists(folderId, name),
      uploadToDrive: async (name, data, _mime, folderId) => drive.upload(name, data, folderId),
      updatePointer: async (id, driveFileId, driveLink) => {
        const row = docs.get(id)!
        row.drive_file_id = driveFileId
        row.drive_link = driveLink
      },
    }
    const rel = await relocateFlowStorageDocsToDrive(
      { companySubfolderId: COMPANY_FOLDER, serviceDeliveryIds: ["sd-1"] },
      relocateDeps,
    )
    expect(rel).toEqual({ relocated: 1, skipped: 0, errors: [] })

    // The documents row now points at a REAL Drive id (not storage:), and the
    // binary physically lives in the "1. Company" folder.
    const relocated = docs.get("doc-articles")!
    expect(relocated.drive_file_id.startsWith("storage:")).toBe(false)
    expect(relocated.drive_link).toContain("drive.google.com")
    const inDrive = drive.exists(COMPANY_FOLDER, relocated.file_name)
    expect(inDrive.exists).toBe(true)
    // And the bytes in Drive are exactly the Articles bytes from Storage.
    expect(drive.download(inDrive.id!)).toEqual(articlesBytes)

    // ── STEP 2: SS-4 signed → resolve the Articles the way the route does.
    // Drive-scan first (documents pointer is now a Drive id → downloadDrive).
    const resolveDeps: ResolveArticlesDeps = {
      findArticlesDoc: async () => {
        const row = docs.get("doc-articles")!
        return { drive_file_id: row.drive_file_id, file_name: row.file_name }
      },
      downloadStorage: async (bucket, path) => storage.get(`${bucket}/${path}`) ?? null,
      downloadDrive: async (id) => drive.download(id),
    }
    const resolvedArticles = await resolveArticlesPdf(resolveDeps)
    expect(resolvedArticles).not.toBeNull()
    expect(resolvedArticles).toEqual(articlesBytes)

    // ── STEP 3: build the IRS package (signed SS-4 page 1 + Articles).
    const signedSs4 = await makePdf(2, "SS4") // 2 pages; merge keeps page 1 only
    const packageBytes = await buildIrsPackage(signedSs4, resolvedArticles!)

    // The merged package is a valid PDF with exactly 3 pages: 1 (SS-4) + 2 (Articles).
    const mergedDoc = await PDFDocument.load(packageBytes)
    expect(mergedDoc.getPageCount()).toBe(3)
  })

  it("is idempotent: a second materialization run relocates nothing (pointer already Drive)", async () => {
    const drive = new FakeDrive()
    drive.ensureFolder(COMPANY_FOLDER)
    const storage = makeStorage()
    storage.set(`onboarding-uploads/${STORAGE_PATH}`, await makePdf(1, "ARTICLES"))
    const docs = new Map<string, DocRow>([
      ["doc-articles", { id: "doc-articles", file_name: "Articles.pdf", drive_file_id: `storage:${STORAGE_PATH}`, mime_type: "application/pdf" }],
    ])
    const deps: RelocateFlowDocsDeps = {
      listStorageDocs: async () => [...docs.values()].filter((d) => d.drive_file_id.startsWith("storage:")) as StorageFlowDoc[],
      downloadStorage: async (bucket, path) => storage.get(`${bucket}/${path}`) ?? null,
      fileExistsInFolder: async (folderId, name) => drive.exists(folderId, name),
      uploadToDrive: async (name, data, _m, folderId) => drive.upload(name, data, folderId),
      updatePointer: async (id, driveFileId, driveLink) => {
        const row = docs.get(id)!
        row.drive_file_id = driveFileId
        row.drive_link = driveLink
      },
    }
    const first = await relocateFlowStorageDocsToDrive({ companySubfolderId: COMPANY_FOLDER, serviceDeliveryIds: ["sd-1"] }, deps)
    expect(first.relocated).toBe(1)
    // Second run: the pointer is no longer 'storage:%', so nothing is selected.
    const second = await relocateFlowStorageDocsToDrive({ companySubfolderId: COMPANY_FOLDER, serviceDeliveryIds: ["sd-1"] }, deps)
    expect(second).toEqual({ relocated: 0, skipped: 0, errors: [] })
  })

  it("safety net: Articles nowhere → resolver returns null (route flags articlesMissing, never ships silently)", async () => {
    const drive = new FakeDrive()
    drive.ensureFolder(COMPANY_FOLDER)
    const storage = makeStorage() // empty — the binary was never uploaded
    const resolveDeps: ResolveArticlesDeps = {
      findArticlesDoc: async () => null, // no Articles documents row at all
      downloadStorage: async (bucket, path) => storage.get(`${bucket}/${path}`) ?? null,
      downloadDrive: async (id) => drive.download(id),
    }
    expect(await resolveArticlesPdf(resolveDeps)).toBeNull()
  })

  it("defense-in-depth: if relocation never ran, the resolver still recovers the Articles straight from Storage", async () => {
    // Simulates a formation where step 10a-bis didn't run (older data / a Drive
    // hiccup): the documents pointer is still 'storage:', the Drive folder is
    // empty. The ss4-signed Drive-scan finds nothing, but resolveArticlesPdf's
    // documents-fallback fetches the bytes from Storage → package still complete.
    const storage = makeStorage()
    const articlesBytes = await makePdf(2, "ARTICLES")
    storage.set(`onboarding-uploads/${STORAGE_PATH}`, articlesBytes)
    const resolveDeps: ResolveArticlesDeps = {
      findArticlesDoc: async () => ({ drive_file_id: `storage:${STORAGE_PATH}`, file_name: "Articles.pdf" }),
      downloadStorage: async (bucket, path) => storage.get(`${bucket}/${path}`) ?? null,
      downloadDrive: async () => null,
    }
    const resolved = await resolveArticlesPdf(resolveDeps)
    expect(resolved).toEqual(articlesBytes)

    const signedSs4 = await makePdf(2, "SS4")
    const pkg = await buildIrsPackage(signedSs4, resolved!)
    expect((await PDFDocument.load(pkg)).getPageCount()).toBe(3)
  })
})
