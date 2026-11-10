import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { basedOnVersion, contentMismatch, decodeUtf8Strict, isProposalNote, PROPOSAL_PREFIX, versionNote } from "@/lib/crm-store/claude-edit-rules"

describe("decodeUtf8Strict — an older text encoding is never rewritten as UTF-8", () => {
  it("returns the text for valid UTF-8 (accents included)", () => {
    expect(decodeUtf8Strict(Buffer.from("Società, perché\n", "utf8"))).toBe("Società, perché\n")
  })
  it("returns null for a Windows-1252 file (a lone 0xE0 byte is not valid UTF-8)", () => {
    expect(decodeUtf8Strict(Buffer.from([0x53, 0x6f, 0x63, 0x69, 0x65, 0x74, 0xe0]))).toBeNull()
  })
})

describe("contentMismatch — the new copy must look like its file name", () => {
  const pdf = Buffer.from("%PDF-1.7\n")
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  it("accepts real PDF / Office / image bytes", () => {
    expect(contentMismatch("a.pdf", pdf)).toBe(false)
    expect(contentMismatch("a.docx", zip)).toBe(false)
    expect(contentMismatch("a.xlsx", zip)).toBe(false)
    expect(contentMismatch("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
    expect(contentMismatch("a.JPG", Buffer.from([0xff, 0xd8, 0xff]))).toBe(false)
  })
  it("flags text saved into a .pdf / .docx, and ignores types it does not know", () => {
    expect(contentMismatch("a.pdf", Buffer.from("hello"))).toBe(true)
    expect(contentMismatch("a.docx", Buffer.from("hello"))).toBe(true)
    expect(contentMismatch("notes.md", Buffer.from("hello"))).toBe(false)
    expect(contentMismatch("noext", Buffer.from("hello"))).toBe(false)
  })
})

describe("a proposal remembers the version it was made from", () => {
  it("is kept at the end of the note, even when the note is long", () => {
    const n = versionNote(PROPOSAL_PREFIX, "x".repeat(900), "why", 7)
    expect(n.length).toBeLessThanOrEqual(600)
    expect(isProposalNote(n)).toBe(true)
    expect(basedOnVersion(n)).toBe(7)
  })
  it("has no tag when no base is given, and an old note reads as unknown", () => {
    expect(versionNote(PROPOSAL_PREFIX, "2 lines added")).toBe("Proposed by Claude: 2 lines added")
    expect(basedOnVersion("Proposed by Claude: 2 lines added")).toBeNull()
    expect(basedOnVersion(null)).toBeNull()
  })
})

describe("the rules that protect the file are in the server code", () => {
  const server = readFileSync("lib/crm-store/claude-edit.ts", "utf8")
  const restore = readFileSync("lib/crm-store/new-version.ts", "utf8")
  it("'does the client see it' uses the same workspace-stage answer as the Storage page", () => {
    expect(server).toContain("clientVisibleFileIds")
  })
  it("a staged upload is removed only after its content was dealt with — a 'please check' keeps it for the retry", () => {
    expect(server).not.toMatch(/finally \{ await removeStaged\(\) \}/)
    expect(server).toMatch(/reply\.status !== "refused"\) await removeStaged\(\)/)
  })
  it("reading is NOT blocked by a lock: passports, IDs and ITIN papers can be opened", () => {
    const open = server.slice(server.indexOf("export async function openStoreFile"), server.indexOf("// ──", server.indexOf("export async function openStoreFile")))
    expect(open).not.toMatch(/throw new Refuse\([^)]*lock/i)
    expect(open).toContain("READING is open on purpose")
  })
  it("accepting a stale proposal is refused, and 'hide' on a workspace-shown file is refused", () => {
    expect(restore).toContain("basedOnVersion(note)")
    expect(restore).toContain("workspaceShownFiles([p.fileId])")
  })
  it("the same change sent twice waits once", () => {
    expect(server).toContain("alreadyWaiting")
  })
})
