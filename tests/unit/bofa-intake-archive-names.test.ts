import { describe, it, expect } from "vitest"
import { applicantFolderName, folderPath, mimeForName, safePart, storedFileName } from "@/lib/bofa-intake/archive-names"

describe("bofa intake archive naming", () => {
  it("builds Business > BofA > partner > applicant paths", () => {
    const p = folderPath({ id: "a1b2c3d4-0000-4000-8000-000000000000", partner: "Max Scale", fullName: "Riley Parker", company: "Parker Trading LLC", submittedAt: "2026-10-12T17:36:48Z" })
    expect(p).toEqual(["BofA", "Max Scale", "2026-10-12 Riley Parker - Parker Trading LLC (a1b2c3)"])
  })

  it("never lets a slash or control character into a folder name (the store refuses them)", () => {
    expect(safePart("AC/DC\\Co\n", "x")).toBe("AC-DC-Co-")
    expect(safePart("   ", "fallback")).toBe("fallback")
    expect(safePart("..", "fallback")).toBe("fallback")
    expect(safePart("a".repeat(500), "x", 120)).toHaveLength(120)
  })

  it("keeps two applicants with the same name apart by the request id", () => {
    const a = applicantFolderName({ id: "aaaaaa11-0000-4000-8000-000000000000", fullName: "Sam Lee", submittedAt: "2026-10-12T00:00:00Z" })
    const b = applicantFolderName({ id: "bbbbbb22-0000-4000-8000-000000000000", fullName: "Sam Lee", submittedAt: "2026-10-12T00:00:00Z" })
    expect(a).not.toBe(b)
  })

  it("falls back for a missing partner, name or date", () => {
    expect(folderPath({ id: "abcdef12-0000-4000-8000-000000000000" })).toEqual(["BofA", "No partner", "undated Applicant (abcdef)"])
  })

  it("names stored files after the box they came from, keeping the extension", () => {
    expect(storedFileName("passport", "IMG 0042.PDF")).toBe("Passport photo page.pdf")
    expect(storedFileName("lease", "scan.jpeg")).toBe("Lease agreement.jpeg")
    expect(storedFileName("other", "noext")).toBe("Anything else the bank asked for")
  })

  it("knows the mime type from the extension", () => {
    expect(mimeForName("a.PDF")).toBe("application/pdf")
    expect(mimeForName("a.heic")).toBe("image/heic")
    expect(mimeForName("a.exe")).toBe("application/octet-stream")
  })
})
