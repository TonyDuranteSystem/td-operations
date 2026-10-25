import { describe, it, expect } from "vitest"
import { isOwnAttachmentUrl } from "@/lib/portal/attachment-url"
import { isOwnStagedUploadPath, safeUploadExtension } from "@/lib/portal/upload-path"

const SUPA = "https://abcd.supabase.co"
const PORTAL = "https://portal.tonydurante.us"

describe("isOwnAttachmentUrl", () => {
  it("accepts our storage and the access-controlled proxy", () => {
    expect(isOwnAttachmentUrl(`${SUPA}/storage/v1/object/public/assets/chat-attachments/x/y.png`, SUPA, PORTAL)).toBe(true)
    expect(isOwnAttachmentUrl(`${PORTAL}/api/portal/chat/attachment?path=chat-attachments%2Facc%2Ff.pdf`, SUPA, PORTAL)).toBe(true)
  })
  it("rejects look-alike hosts and credentials tricks", () => {
    expect(isOwnAttachmentUrl("https://abcd.supabase.co.attacker.tld/storage/v1/object/x", SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl("https://abcd.supabase.co@attacker.tld/storage/v1/object/x", SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl("https://attacker.tld/?https://abcd.supabase.co/storage/v1/object/x", SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl("https://portal.tonydurante.us.evil.com/api/portal/chat/attachment?path=chat-attachments/a/b", SUPA, PORTAL)).toBe(false)
  })
  it("rejects other paths on our hosts, traversal, wrong scheme, junk", () => {
    expect(isOwnAttachmentUrl(`${SUPA}/auth/v1/user`, SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl(`${PORTAL}/api/portal/chat/attachment?path=../x`, SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl(`${PORTAL}/api/portal/chat/attachment?path=other/x`, SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl("javascript:alert(1)", SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl("", SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl(null, SUPA, PORTAL)).toBe(false)
    expect(isOwnAttachmentUrl(`${SUPA}/storage/v1/object/x`, "", PORTAL)).toBe(false)
  })
})

describe("isOwnStagedUploadPath", () => {
  it("accepts <account>/<file> only", () => {
    expect(isOwnStagedUploadPath("acc-1", "acc-1/uuid.pdf")).toBe(true)
    expect(isOwnStagedUploadPath("acc-1", "acc-2/uuid.pdf")).toBe(false)
    expect(isOwnStagedUploadPath("acc-1", "acc-1/../acc-2/x.pdf")).toBe(false)
    expect(isOwnStagedUploadPath("acc-1", "acc-1/sub/x.pdf")).toBe(false)
    expect(isOwnStagedUploadPath("acc-1", "acc-1/")).toBe(false)
    expect(isOwnStagedUploadPath("acc-1", "acc-10/x.pdf")).toBe(false)
    expect(isOwnStagedUploadPath("", "/x.pdf")).toBe(false)
    expect(isOwnStagedUploadPath("a/b", "a/b/x.pdf")).toBe(false)
    expect(isOwnStagedUploadPath("acc-1", undefined)).toBe(false)
  })
})

describe("safeUploadExtension", () => {
  it("keeps normal extensions and neutralises slashes and junk", () => {
    expect(safeUploadExtension("Report.PDF")).toBe("pdf")
    expect(safeUploadExtension("a.b/../../etc")).toBe("pdf")
    expect(safeUploadExtension("evil.x/y")).toBe("pdf")
    expect(safeUploadExtension("noext")).toBe("pdf")
    expect(safeUploadExtension("x.waytoolongextension")).toBe("pdf")
    expect(safeUploadExtension(42, "bin")).toBe("bin")
  })
})
