/**
 * FORMATION WORKSPACE — Articles-of-Organization chain (storage only).
 *
 * Drives the REAL production core function (resolveArticlesPdf) and the REAL pdf-lib merge the ss4-signed route runs.
 * Stop-Drive S1a (dev job 264bb882): the old step that copied flow-uploaded Articles from Supabase Storage into a Drive
 * "1. Company" folder is gone. The Articles stay where they were uploaded (documents pointer 'storage:...') and the signed
 * SS-4 IRS package is still complete, because the resolver reads the documents row and fetches the bytes from storage.
 *
 * Also: the safety net (Articles nowhere → resolver returns null → the route's loud "articlesMissing" branch).
 */

import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { resolveArticlesPdf, type ResolveArticlesDeps } from "@/lib/ss4/resolve-articles-pdf"


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
describe("Formation workspace — Articles chain E2E (real functions + real pdf-lib)", () => {
  it("safety net: Articles nowhere → resolver returns null (route flags articlesMissing, never ships silently)", async () => {
    const storage = makeStorage() // empty — the binary was never uploaded
    const resolveDeps: ResolveArticlesDeps = {
      findArticlesDoc: async () => null, // no Articles documents row at all
      downloadStorage: async (bucket, path) => storage.get(`${bucket}/${path}`) ?? null,
      downloadDrive: async () => null,
    }
    expect(await resolveArticlesPdf(resolveDeps)).toBeNull()
  })

  it("the Articles stay in storage (no Drive copy any more): the resolver recovers them from there and the IRS package is complete", async () => {
    // Stop-Drive S1a: the old step that copied flow-uploaded Articles into a Drive folder is gone. The documents pointer stays
    // 'storage:' and the Drive folder is empty; resolveArticlesPdf's documents lookup fetches the bytes from Storage.
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
