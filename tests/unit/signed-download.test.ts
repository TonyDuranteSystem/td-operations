import { describe, it, expect } from "vitest"
import { normalizeStoragePath } from "@/lib/storage/signed-download"

describe("normalizeStoragePath — signs the recorded path, fails closed on junk", () => {
  it("accepts a normal recorded path (token/file)", () => {
    expect(normalizeStoragePath("abc123/contract-signed-1775819405636.pdf")).toBe(
      "abc123/contract-signed-1775819405636.pdf",
    )
  })

  it("strips a leading slash (paths are bucket-relative)", () => {
    expect(normalizeStoragePath("/abc/x.pdf")).toBe("abc/x.pdf")
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeStoragePath("  abc/x.pdf  ")).toBe("abc/x.pdf")
  })

  it("fails closed on null / undefined / empty / non-string", () => {
    expect(normalizeStoragePath(null)).toBeNull()
    expect(normalizeStoragePath(undefined)).toBeNull()
    expect(normalizeStoragePath("")).toBeNull()
    expect(normalizeStoragePath("   ")).toBeNull()
    // @ts-expect-error deliberately wrong type
    expect(normalizeStoragePath(123)).toBeNull()
  })

  it("rejects parent-directory traversal and backslashes", () => {
    expect(normalizeStoragePath("abc/../../etc/passwd")).toBeNull()
    expect(normalizeStoragePath("..")).toBeNull()
    expect(normalizeStoragePath("abc\\x.pdf")).toBeNull()
  })
})
