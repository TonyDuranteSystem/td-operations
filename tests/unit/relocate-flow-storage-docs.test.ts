/**
 * lib/flows/relocate-flow-storage-docs.ts — moves formation "Filed with State"
 * documents (the Articles of Organization) that are still parked in Supabase
 * Storage into the company's Drive "1. Company" folder at materialization.
 *
 * Root-cause fix for the 2026-07-08 Slack report: Articles missing from Google
 * Drive + not merged into the SS-4 IRS package.
 */

import { describe, it, expect, vi } from "vitest"
import {
  relocateFlowStorageDocsToDrive,
  type RelocateFlowDocsDeps,
  type StorageFlowDoc,
} from "@/lib/flows/relocate-flow-storage-docs"

function makeDeps(overrides: Partial<RelocateFlowDocsDeps> = {}): {
  deps: RelocateFlowDocsDeps
  updates: Array<{ docId: string; driveFileId: string; driveLink: string }>
  uploads: Array<{ fileName: string; folderId: string; size: number }>
} {
  const updates: Array<{ docId: string; driveFileId: string; driveLink: string }> = []
  const uploads: Array<{ fileName: string; folderId: string; size: number }> = []
  const deps: RelocateFlowDocsDeps = {
    listStorageDocs: async () => [],
    downloadStorage: async () => Buffer.from("PDFDATA"),
    fileExistsInFolder: async () => ({ exists: false }),
    uploadToDrive: async (fileName, data, _mime, folderId) => {
      uploads.push({ fileName, folderId, size: data.length })
      return { id: `drive-${fileName}` }
    },
    updatePointer: async (docId, driveFileId, driveLink) => {
      updates.push({ docId, driveFileId, driveLink })
    },
    ...overrides,
  }
  return { deps, updates, uploads }
}

const articlesDoc: StorageFlowDoc = {
  id: "doc-1",
  file_name: "Domestic LLC Articles of Organization  (18).pdf",
  drive_file_id: "storage:flow-uploads/sd-1/1783532776252_Domestic LLC Articles of Organization  (18).pdf",
  mime_type: "application/pdf",
}

describe("relocateFlowStorageDocsToDrive", () => {
  it("downloads from Storage, uploads to the Company folder, and repoints the doc", async () => {
    const { deps, updates, uploads } = makeDeps({
      listStorageDocs: async () => [articlesDoc],
    })
    const res = await relocateFlowStorageDocsToDrive(
      { companySubfolderId: "company-folder", serviceDeliveryIds: ["sd-1"] },
      deps,
    )
    expect(res).toEqual({ relocated: 1, skipped: 0, errors: [] })
    expect(uploads).toEqual([
      { fileName: articlesDoc.file_name, folderId: "company-folder", size: Buffer.from("PDFDATA").length },
    ])
    expect(updates).toEqual([
      {
        docId: "doc-1",
        driveFileId: "drive-" + articlesDoc.file_name,
        driveLink: `https://drive.google.com/file/d/drive-${articlesDoc.file_name}/view`,
      },
    ])
  })

  it("strips only the 'storage:' prefix to derive the storage path", async () => {
    let seenPath = ""
    const { deps } = makeDeps({
      listStorageDocs: async () => [articlesDoc],
      downloadStorage: async (bucket, path) => {
        expect(bucket).toBe("onboarding-uploads")
        seenPath = path
        return Buffer.from("X")
      },
    })
    await relocateFlowStorageDocsToDrive(
      { companySubfolderId: "company-folder", serviceDeliveryIds: ["sd-1"] },
      deps,
    )
    expect(seenPath).toBe(
      "flow-uploads/sd-1/1783532776252_Domestic LLC Articles of Organization  (18).pdf",
    )
  })

  it("relinks (does NOT re-upload) when a same-name file already exists in the folder", async () => {
    const upload = vi.fn(async () => ({ id: "should-not-happen" }))
    const { deps, updates } = makeDeps({
      listStorageDocs: async () => [articlesDoc],
      fileExistsInFolder: async () => ({ exists: true, id: "existing-drive-id" }),
      uploadToDrive: upload,
    })
    const res = await relocateFlowStorageDocsToDrive(
      { companySubfolderId: "company-folder", serviceDeliveryIds: ["sd-1"] },
      deps,
    )
    expect(upload).not.toHaveBeenCalled()
    expect(res).toEqual({ relocated: 0, skipped: 1, errors: [] })
    expect(updates).toEqual([
      {
        docId: "doc-1",
        driveFileId: "existing-drive-id",
        driveLink: "https://drive.google.com/file/d/existing-drive-id/view",
      },
    ])
  })

  it("skips a doc whose pointer is already a real Drive id (idempotent re-run)", async () => {
    const { deps, uploads } = makeDeps({
      listStorageDocs: async () => [{ ...articlesDoc, drive_file_id: "1V8loB5realDriveId" }],
    })
    const res = await relocateFlowStorageDocsToDrive(
      { companySubfolderId: "company-folder", serviceDeliveryIds: ["sd-1"] },
      deps,
    )
    expect(res).toEqual({ relocated: 0, skipped: 1, errors: [] })
    expect(uploads).toEqual([])
  })

  it("collects a per-doc error without throwing, and keeps processing others", async () => {
    const good: StorageFlowDoc = {
      ...articlesDoc,
      id: "doc-2",
      file_name: "good.pdf",
      drive_file_id: "storage:flow-uploads/sd-1/1783532776999_good.pdf",
    }
    const { deps, updates } = makeDeps({
      listStorageDocs: async () => [articlesDoc, good],
      downloadStorage: async (_b, path) => (path.includes("(18)") ? null : Buffer.from("Y")),
    })
    const res = await relocateFlowStorageDocsToDrive(
      { companySubfolderId: "company-folder", serviceDeliveryIds: ["sd-1"] },
      deps,
    )
    expect(res.relocated).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toContain("storage download returned no data")
    expect(updates).toHaveLength(1)
    expect(updates[0].docId).toBe("doc-2")
  })

  it("no-ops when there is no company subfolder or no SD ids", async () => {
    const { deps: d1 } = makeDeps({ listStorageDocs: async () => [articlesDoc] })
    expect(await relocateFlowStorageDocsToDrive({ companySubfolderId: null, serviceDeliveryIds: ["sd-1"] }, d1)).toEqual({
      relocated: 0,
      skipped: 0,
      errors: [],
    })
    const { deps: d2 } = makeDeps({ listStorageDocs: async () => [articlesDoc] })
    expect(await relocateFlowStorageDocsToDrive({ companySubfolderId: "f", serviceDeliveryIds: [] }, d2)).toEqual({
      relocated: 0,
      skipped: 0,
      errors: [],
    })
  })
})
