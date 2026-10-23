import { describe, it, expect, afterEach } from "vitest"
import {
  ACCESS_LIMITS, accessEnabled, accessRateRefusal, checkRenamedFile, clipText, isTextual, isUuid, parseFolderPath, parseIfExists, parseOptionalPath,
} from "@/lib/crm-store/my-files-access-rules"

afterEach(() => { delete process.env.MY_FILES_ACCESS_ENABLED })

describe("the switch", () => {
  it("is OFF unless exactly 1", () => {
    expect(accessEnabled()).toBe(false)
    for (const v of ["0", "true", "yes", ""]) { process.env.MY_FILES_ACCESS_ENABLED = v; expect(accessEnabled(), v).toBe(false) }
    process.env.MY_FILES_ACCESS_ENABLED = "1"
    expect(accessEnabled()).toBe(true)
  })
})

describe("rate limits", () => {
  it("refuses at the cap, not before", () => {
    expect(accessRateRefusal("read", ACCESS_LIMITS.readsPerHour - 1)).toBeNull()
    expect(accessRateRefusal("read", ACCESS_LIMITS.readsPerHour)).toMatch(/reads/)
    expect(accessRateRefusal("change", ACCESS_LIMITS.changesPerHour - 1)).toBeNull()
    expect(accessRateRefusal("change", ACCESS_LIMITS.changesPerHour)).toMatch(/changes/)
  })
})

describe("paths", () => {
  it("accepts 1–6 clean names, trims, drops empty parts", () => {
    expect(parseFolderPath(" TD Marketing / Plans /")).toEqual({ ok: true, segments: ["TD Marketing", "Plans"] })
    expect(parseFolderPath("a/b/c/d/e/f").ok).toBe(true)
  })
  it("refuses empty, too deep, dot-paths, backslash, control and look-alike characters", () => {
    for (const bad of ["", "   ", "/", "a/b/c/d/e/f/g", "../x", "a/./b", "a\\b", "a/b\u0000", "a/‮b", "a/​b", "x".repeat(121), 5, null, undefined]) {
      expect(parseFolderPath(bad as never).ok, String(bad)).toBe(false)
    }
  })
  it("optional path: nothing or / means the top", () => {
    for (const v of [undefined, null, "", "  ", "/"]) expect(parseOptionalPath(v)).toEqual({ ok: true, segments: [] })
    expect(parseOptionalPath("../x").ok).toBe(false)
    expect(parseOptionalPath("Plans")).toEqual({ ok: true, segments: ["Plans"] })
  })
})

describe("if_exists", () => {
  it("defaults to refuse; only the three words are accepted", () => {
    expect(parseIfExists(undefined)).toBe("refuse")
    expect(parseIfExists(null)).toBe("refuse")
    for (const v of ["refuse", "new_version", "copy"]) expect(parseIfExists(v)).toBe(v)
    for (const v of ["overwrite", "replace", "REFUSE", 1, true]) expect(parseIfExists(v)).toBeNull()
  })
})

describe("ids and text", () => {
  it("isUuid accepts uuids only", () => {
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true)
    for (const v of ["", "abc", "0f8fad5b-d9cb-469f-a165-70867728950e'--", null, 5]) expect(isUuid(v)).toBe(false)
  })
  it("isTextual by extension or MIME", () => {
    expect(isTextual("a.md", null)).toBe(true)
    expect(isTextual("a.CSV", "application/octet-stream")).toBe(true)
    expect(isTextual("a.bin", "text/plain")).toBe(true)
    expect(isTextual("a.pdf", "application/pdf")).toBe(false)
    expect(isTextual("noext", null)).toBe(false)
  })
  it("clipText cuts at the limit and says so", () => {
    expect(clipText("abc")).toEqual({ text: "abc", cut: false })
    const long = "x".repeat(ACCESS_LIMITS.maxReadChars + 5)
    const c = clipText(long)
    expect(c.cut).toBe(true)
    expect(c.text.length).toBe(ACCESS_LIMITS.maxReadChars)
  })
})

describe("renaming a file", () => {
  it("keeps the extension and cleans separators", () => {
    expect(checkRenamedFile("New plan", "Old plan.md")).toEqual({ ok: true, name: "New plan.md" })
    expect(checkRenamedFile("New plan.md", "Old plan.md")).toEqual({ ok: true, name: "New plan.md" })
  })
  it("a name with a different extension gets the old one appended — the extension never changes", () => {
    expect(checkRenamedFile("x.html", "a.md")).toEqual({ ok: true, name: "x.html.md" })
  })
  it("refuses empty, leading dot, trailing dot/space, look-alike characters, non-text", () => {
    for (const bad of ["", "   ", ".hidden", "a‮b", "a​b", 7, null]) expect(checkRenamedFile(bad as never, "a.md").ok, String(bad)).toBe(false)
  })
})
