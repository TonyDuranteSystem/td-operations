/**
 * Attach a My files › "From Claude" file to a Claude post in Team Chat — the pure rules (dev job f34c915d).
 */
import { describe, it, expect } from "vitest"
import {
  CHAT_MAX_ATTACHMENTS, MY_FILES_CHAT_MAX_BYTES, chatObjectPath, checkMyFileForChat, copyContentType, inDropFolder, safeExtension, splitAttachmentRefs,
} from "@/lib/team/attach-from-my-files-rules"

const ID_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
const ID_B = "1f8fad5b-d9cb-469f-a165-70867728950e"
const LINK = { url: "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/x.pdf", name: "x.pdf" }

describe("splitAttachmentRefs", () => {
  it("nothing, empty and null are fine", () => {
    for (const v of [undefined, null, []]) expect(splitAttachmentRefs(v)).toEqual({ ok: true, links: [], fileIds: [] })
  })

  it("sorts ready links from My files ids and keeps the order of the links", () => {
    const r = splitAttachmentRefs([LINK, { my_files_file_id: ID_A }, { ...LINK, name: "y.pdf", mime_type: "application/pdf", size: 5 }])
    expect(r).toEqual({
      ok: true,
      links: [LINK, { url: LINK.url, name: "y.pdf", mime_type: "application/pdf", size: 5 }],
      fileIds: [ID_A],
    })
  })

  it("a slot takes EITHER a url OR a file id — both or neither is refused", () => {
    expect(splitAttachmentRefs([{ ...LINK, my_files_file_id: ID_A }])).toMatchObject({ ok: false, error: expect.stringMatching(/EITHER a url OR a my_files_file_id/) })
    expect(splitAttachmentRefs([{ name: "x.pdf" }])).toMatchObject({ ok: false, error: expect.stringMatching(/needs a url or a my_files_file_id/) })
    expect(splitAttachmentRefs([{ url: "  ", my_files_file_id: "" }])).toMatchObject({ ok: false })
  })

  it("a url needs a name; a file id does not (the file's own name is used)", () => {
    expect(splitAttachmentRefs([{ url: LINK.url }])).toMatchObject({ ok: false, error: expect.stringMatching(/needs a name/) })
    expect(splitAttachmentRefs([{ my_files_file_id: ID_A }])).toMatchObject({ ok: true, fileIds: [ID_A] })
  })

  it("refuses an id that is not a file id, and the same file listed twice (any letter case)", () => {
    for (const bad of ["abc", "../../x", 42, "0f8fad5b-d9cb-469f-a165-70867728950"]) {
      expect(splitAttachmentRefs([{ my_files_file_id: bad }]), String(bad)).toMatchObject({ ok: false })
    }
    expect(splitAttachmentRefs([{ my_files_file_id: ID_A }, { my_files_file_id: ID_A.toUpperCase() }])).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) })
    expect(splitAttachmentRefs([{ my_files_file_id: ID_A }, { my_files_file_id: ID_B }])).toMatchObject({ ok: true, fileIds: [ID_A, ID_B] })
  })

  it("at most five per message, links and files counted together", () => {
    const six = Array.from({ length: CHAT_MAX_ATTACHMENTS + 1 }, (_, i) => ({ ...LINK, name: `f${i}.pdf` }))
    expect(splitAttachmentRefs(six)).toMatchObject({ ok: false, error: expect.stringMatching(/At most 5/) })
    expect(splitAttachmentRefs(six.slice(0, 5))).toMatchObject({ ok: true })
    expect(CHAT_MAX_ATTACHMENTS).toBe(5)
  })
})

describe("inDropFolder", () => {
  it("true when the drop folder is anywhere in the folder's chain", () => {
    expect(inDropFolder(["sub", "drop", "root"], "drop")).toBe(true)
    expect(inDropFolder(["drop", "root"], "drop")).toBe(true)
  })
  it("false for another folder, an empty chain, or no drop folder — never yes by default", () => {
    expect(inDropFolder(["other", "root"], "drop")).toBe(false)
    expect(inDropFolder([], "drop")).toBe(false)
    expect(inDropFolder(["drop"], null)).toBe(false)
    expect(inDropFolder(["drop"], undefined)).toBe(false)
    expect(inDropFolder(["drop"], "")).toBe(false)
  })
})

describe("checkMyFileForChat", () => {
  it("allows a normal PDF, image or document under the cap", () => {
    expect(checkMyFileForChat({ name: "mockup.pdf", size: 574673, mimeType: "application/pdf" })).toBeNull()
    expect(checkMyFileForChat({ name: "shot.PNG", size: 10, mimeType: "image/png" })).toBeNull()
    expect(checkMyFileForChat({ name: "plan.docx", size: MY_FILES_CHAT_MAX_BYTES, mimeType: null })).toBeNull()
  })

  it("refuses a size that cannot be verified, an empty file, and anything over the cap", () => {
    for (const size of [null, undefined, "abc", Number.NaN, -1]) {
      expect(checkMyFileForChat({ name: "a.pdf", size, mimeType: "application/pdf" }), String(size)).toMatch(/size could not be verified/)
    }
    expect(checkMyFileForChat({ name: "a.pdf", size: 0, mimeType: "application/pdf" })).toMatch(/is empty/)
    expect(checkMyFileForChat({ name: "big.pdf", size: MY_FILES_CHAT_MAX_BYTES + 1, mimeType: "application/pdf" })).toMatch(/too big to attach from here \(limit 20 MB\)/)
  })

  it("refuses web pages, scripts and programs — by name OR by type — because the link is public", () => {
    for (const [name, mimeType] of [["page.html", "text/html"], ["x.svg", "image/svg+xml"], ["run.sh", null], ["app.exe", "application/x-msdownload"], ["notes.pdf", "text/html"], ["x.JS", "application/javascript"]] as const) {
      expect(checkMyFileForChat({ name, size: 10, mimeType }), name).toMatch(/can't be sent in chat for security reasons/)
    }
  })
})

describe("object name helpers", () => {
  it("safeExtension keeps a short lower-case extension, else bin", () => {
    expect(safeExtension("Mockup.PDF")).toBe("pdf")
    expect(safeExtension("a.tar.gz")).toBe("gz")
    expect(safeExtension("noext")).toBe("bin")
    expect(safeExtension("weird.p/d f")).toBe("pdf")
    expect(safeExtension("x.averyveryverylongextension")).toBe("averyver")
    expect(safeExtension("trailingdot.")).toBe("bin")
  })

  it("chatObjectPath puts the copy under team-chat/claude/ with a fresh id and the safe extension", () => {
    expect(chatObjectPath("Mockup.PDF", "abc")).toBe("team-chat/claude/abc.pdf")
    const a = chatObjectPath("a.pdf")
    const b = chatObjectPath("a.pdf")
    expect(a).toMatch(/^team-chat\/claude\/[0-9a-f-]{36}\.pdf$/)
    expect(a).not.toBe(b)
  })

  it("copyContentType uses the file's own type, without parameters, else octet-stream", () => {
    expect(copyContentType("application/pdf")).toBe("application/pdf")
    expect(copyContentType("Text/Plain; charset=utf-8")).toBe("text/plain")
    expect(copyContentType(null)).toBe("application/octet-stream")
    expect(copyContentType("")).toBe("application/octet-stream")
  })
})
