import { describe, it, expect } from "vitest"
import { isFaxStagingPath, faxStagingPathFor, faxSizeProblem, FAX_UPLOAD_MAX_BYTES, FAX_INLINE_MAX_BYTES } from "@/lib/fax/staged-upload"

describe("fax staged upload", () => {
  it("the path the server makes is the only shape the send route accepts", () => {
    const p = faxStagingPathFor("123e4567-e89b-12d3-a456-426614174000", "Big Scan.PDF")
    expect(p).toBe("fax-upload/123e4567-e89b-12d3-a456-426614174000.pdf")
    expect(isFaxStagingPath(p)).toBe(true)
    for (const bad of ["../x", "fax-upload/../secret.pdf", "fax-upload/abc.pdf", "other/123e4567-e89b-12d3-a456-426614174000.pdf", "fax-upload/123e4567-e89b-12d3-a456-426614174000.pdf/../x", 5, null]) expect(isFaxStagingPath(bad as never), String(bad)).toBe(false)
  })
  it("no fragment of the file name leaks into the path (only a known ending is kept)", () => {
    const U = "123e4567-e89b-12d3-a456-426614174000"
    expect(faxStagingPathFor(U, "Rossi Passport.secret")).toBe(`fax-upload/${U}.bin`)
    expect(faxStagingPathFor(U, "ssn-123-45-6789")).toBe(`fax-upload/${U}.bin`)
    expect(faxStagingPathFor(U, "scan.TIFF")).toBe(`fax-upload/${U}.tiff`)
    expect(faxStagingPathFor(U, "noextension")).toBe(`fax-upload/${U}.bin`)
    expect(isFaxStagingPath(faxStagingPathFor(U, "x.y z"))).toBe(true)
  })
  it("sizes: small files go inline, big ones are staged, huge ones get a plain sentence", () => {
    expect(FAX_INLINE_MAX_BYTES).toBe(3 * 1024 * 1024)
    expect(faxSizeProblem(FAX_UPLOAD_MAX_BYTES)).toBeNull()
    expect(faxSizeProblem(FAX_UPLOAD_MAX_BYTES + 1)).toMatch(/too big to fax/)
  })
})
