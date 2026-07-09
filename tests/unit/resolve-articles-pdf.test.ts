/**
 * lib/ss4/resolve-articles-pdf.ts — source-of-truth fallback for the signed-SS-4
 * IRS merge. Fetches the Articles of Organization from the documents table,
 * reading the binary from Drive OR Supabase Storage depending on the pointer.
 */

import { describe, it, expect, vi } from "vitest"
import { resolveArticlesPdf, type ResolveArticlesDeps } from "@/lib/ss4/resolve-articles-pdf"

function makeDeps(overrides: Partial<ResolveArticlesDeps> = {}): ResolveArticlesDeps {
  return {
    findArticlesDoc: async () => null,
    downloadStorage: async () => Buffer.from("STORAGE"),
    downloadDrive: async () => Buffer.from("DRIVE"),
    ...overrides,
  }
}

describe("resolveArticlesPdf", () => {
  it("fetches from Supabase Storage for a 'storage:' pointer, stripping only the prefix", async () => {
    const downloadStorage = vi.fn(async () => Buffer.from("STORAGE"))
    const downloadDrive = vi.fn(async () => Buffer.from("DRIVE"))
    const deps = makeDeps({
      findArticlesDoc: async () => ({
        drive_file_id: "storage:flow-uploads/sd-1/1783532776252_Articles.pdf",
        file_name: "Articles.pdf",
      }),
      downloadStorage,
      downloadDrive,
    })
    const buf = await resolveArticlesPdf(deps)
    expect(buf?.toString()).toBe("STORAGE")
    expect(downloadStorage).toHaveBeenCalledWith(
      "onboarding-uploads",
      "flow-uploads/sd-1/1783532776252_Articles.pdf",
    )
    expect(downloadDrive).not.toHaveBeenCalled()
  })

  it("fetches from Drive for a real Drive id", async () => {
    const downloadDrive = vi.fn(async () => Buffer.from("DRIVE"))
    const deps = makeDeps({
      findArticlesDoc: async () => ({ drive_file_id: "1V8loB5realDriveId", file_name: "Articles.pdf" }),
      downloadDrive,
    })
    const buf = await resolveArticlesPdf(deps)
    expect(buf?.toString()).toBe("DRIVE")
    expect(downloadDrive).toHaveBeenCalledWith("1V8loB5realDriveId")
  })

  it("returns null when no Articles doc exists", async () => {
    expect(await resolveArticlesPdf(makeDeps({ findArticlesDoc: async () => null }))).toBeNull()
  })

  it("returns null (never throws) when the download fails", async () => {
    const deps = makeDeps({
      findArticlesDoc: async () => ({ drive_file_id: "storage:flow-uploads/sd-1/x.pdf", file_name: "x.pdf" }),
      downloadStorage: async () => {
        throw new Error("boom")
      },
    })
    expect(await resolveArticlesPdf(deps)).toBeNull()
  })

  it("returns null when the storage download returns no data", async () => {
    const deps = makeDeps({
      findArticlesDoc: async () => ({ drive_file_id: "storage:flow-uploads/sd-1/x.pdf", file_name: "x.pdf" }),
      downloadStorage: async () => null,
    })
    expect(await resolveArticlesPdf(deps)).toBeNull()
  })
})
