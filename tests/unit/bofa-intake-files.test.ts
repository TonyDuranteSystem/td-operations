/**
 * What a submitted file is CALLED when it is attached, linked or shown to staff: the name and type of the bytes really in
 * Storage, not of the name the applicant's phone gave. (An iPhone photo is stored as a JPEG; calling it ".HEIC" can make the
 * bank contact's mail viewer refuse to open a passport.) Run against a fake Storage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  queried: [] as string[],
  selects: [] as string[],
  versionMime: "image/jpeg" as string | null,
  versionMissing: false,
  signedDownloadNames: [] as unknown[],
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    h.queried.push(table)
    const b: Record<string, unknown> = {}
    b.select = (cols: string) => { h.selects.push(`${table}:${cols}`); return b }
    b.eq = () => b
    b.maybeSingle = () => {
      if (table === "store_files") return Promise.resolve({ data: { current_version_id: "v1" }, error: null })
      if (table === "store_file_versions") {
        return Promise.resolve({ data: h.versionMissing ? null : { storage_bucket: "crm-files", storage_path: "o/x", mime_type: h.versionMime }, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }
    return b
  }
  const storage = {
    from: () => ({
      createSignedUrl: async (_path: string, _secs: number, opts: { download: string }) => {
        h.signedDownloadNames.push(opts.download)
        return { data: { signedUrl: "https://signed.example/f" }, error: null }
      },
    }),
  }
  return { supabaseAdmin: { from: builder, storage } }
})

import { describeSubmissionFile, signedUrlForSubmissionFile } from "@/lib/bofa-intake/files"

const stored = (name: string) => ({ key: "passport", name, path: "t/passport/x", store_file_id: "sf1" })

beforeEach(() => {
  h.queried = []
  h.selects = []
  h.versionMime = "image/jpeg"
  h.versionMissing = false
  h.signedDownloadNames = []
})

describe("describeSubmissionFile", () => {
  it("an iPhone photo stored as a JPEG is described as a .jpg with the JPEG type", async () => {
    expect(await describeSubmissionFile(stored("IMG_4521.HEIC"))).toEqual({ name: "IMG_4521.jpg", contentType: "image/jpeg" })
  })

  it("reads the file's type from the stored version's mime_type column (the column really named in the query)", async () => {
    await describeSubmissionFile(stored("IMG_4521.HEIC"))
    expect(h.selects.some((s) => s.startsWith("store_file_versions:") && s.includes("mime_type"))).toBe(true)
  })

  it("if the conversion failed and the original HEIC is what is stored, it keeps the HEIC name and type", async () => {
    h.versionMime = "image/heic"
    expect(await describeSubmissionFile(stored("IMG_4521.HEIC"))).toEqual({ name: "IMG_4521.HEIC", contentType: "image/heic" })
  })

  it("a PDF stays a PDF", async () => {
    h.versionMime = "application/pdf"
    expect(await describeSubmissionFile(stored("Passport.pdf"))).toEqual({ name: "Passport.pdf", contentType: "application/pdf" })
  })

  it("a file still in the temporary upload folder is described by its own name, with no Storage lookup", async () => {
    const r = await describeSubmissionFile({ key: "passport", name: "scan.PNG", path: "t/passport/x" })
    expect(r).toEqual({ name: "scan.PNG", contentType: "image/png" })
    expect(h.queried).toEqual([])
  })

  it("if the stored version cannot be found, the name is left as it is (never guessed)", async () => {
    h.versionMissing = true
    expect(await describeSubmissionFile(stored("IMG_4521.HEIC"))).toEqual({ name: "IMG_4521.HEIC", contentType: "image/heic" })
  })

  it("a stored type we do not know leaves the name as it is", async () => {
    h.versionMime = null
    expect(await describeSubmissionFile(stored("IMG_4521.HEIC"))).toEqual({ name: "IMG_4521.HEIC", contentType: "image/heic" })
  })
})

describe("the staff / bank-contact download link carries the same real name", () => {
  it("is offered for download as IMG_4521.jpg, not IMG_4521.HEIC", async () => {
    const url = await signedUrlForSubmissionFile(stored("IMG_4521.HEIC"), 3600)
    expect(url).toBe("https://signed.example/f")
    expect(h.signedDownloadNames).toEqual(["IMG_4521.jpg"])
  })
})
