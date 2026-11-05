/**
 * attachMyFilesToChat — the copy from My files into Team Chat's own storage (dev job f34c915d). Reads are mocked; what matters here is what
 * gets uploaded and where, the links handed back, and the clean-up when anything fails (all or nothing).
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const upload = vi.fn()
const remove = vi.fn()
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, bytes: Buffer, opts: unknown) => upload(bucket, path, bytes, opts),
        remove: (paths: string[]) => remove(bucket, paths),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
      }),
    },
  },
}))
const readMyFileForChat = vi.fn()
vi.mock("@/lib/crm-store/my-files-access", () => ({ readMyFileForChat: (...a: unknown[]) => readMyFileForChat(...a) }))

import { attachMyFilesToChat, removeChatCopies } from "@/lib/team/attach-from-my-files"

const caller = { method: "static", email: "antonio.durante@tonydurante.us" }
const IDS = ["0f8fad5b-d9cb-469f-a165-70867728950e", "1f8fad5b-d9cb-469f-a165-70867728950e"]
const pdf = (name: string) => ({ ok: true, name, folder: "From Claude", size: 4, mime_type: "application/pdf", bytes: Buffer.from("%PDF") })

beforeEach(() => {
  vi.clearAllMocks()
  upload.mockResolvedValue({ error: null })
  remove.mockResolvedValue({ error: null })
})

describe("attachMyFilesToChat", () => {
  it("copies the bytes into the public assets bucket under team-chat/claude/, and hands back a real attachment", async () => {
    readMyFileForChat.mockResolvedValueOnce(pdf("Mockup.PDF"))
    const r = await attachMyFilesToChat([IDS[0]], caller)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(readMyFileForChat).toHaveBeenCalledWith({ file_id: IDS[0] }, caller)
    expect(upload).toHaveBeenCalledTimes(1)
    const [bucket, path, bytes, opts] = upload.mock.calls[0]
    expect(bucket).toBe("assets")
    expect(path).toMatch(/^team-chat\/claude\/[0-9a-f-]{36}\.pdf$/)
    expect(bytes.toString()).toBe("%PDF")
    expect(opts).toEqual({ contentType: "application/pdf", upsert: false })
    expect(r.paths).toEqual([path])
    expect(r.attachments).toEqual([{ url: `https://proj.supabase.co/storage/v1/object/public/assets/${path}`, name: "Mockup.PDF", mime_type: "application/pdf", size: 4 }])
  })

  it("several files keep their order, each with its own object", async () => {
    readMyFileForChat.mockResolvedValueOnce(pdf("a.pdf")).mockResolvedValueOnce({ ...pdf("b.png"), mime_type: null })
    const r = await attachMyFilesToChat(IDS, caller)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.attachments.map((a) => a.name)).toEqual(["a.pdf", "b.png"])
    expect(r.attachments[1].mime_type).toBe("application/octet-stream")
    expect(new Set(r.paths).size).toBe(2)
  })

  it("a refusal on a later file removes the copies already made — all or nothing", async () => {
    readMyFileForChat.mockResolvedValueOnce(pdf("a.pdf")).mockResolvedValueOnce({ ok: false, error: "\"b.html\": This file type can't be sent in chat for security reasons." })
    const r = await attachMyFilesToChat(IDS, caller)
    expect(r).toEqual({ ok: false, error: "\"b.html\": This file type can't be sent in chat for security reasons." })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith("assets", [upload.mock.calls[0][1]])
  })

  it("a failed upload is a plain message, never the storage error, and earlier copies are removed", async () => {
    readMyFileForChat.mockResolvedValueOnce(pdf("a.pdf")).mockResolvedValueOnce(pdf("b.pdf"))
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "bucket exploded: secret detail" } })
    const r = await attachMyFilesToChat(IDS, caller)
    expect(r.ok).toBe(false)
    if (r.ok !== false) return
    expect(r.error).toMatch(/"b.pdf": The file could not be copied to chat storage right now\. Nothing was posted/)
    expect(r.error).not.toMatch(/secret detail/)
    expect(remove).toHaveBeenCalledWith("assets", [upload.mock.calls[0][1]])
  })

  it("an unexpected error is a plain message and still cleans up", async () => {
    readMyFileForChat.mockResolvedValueOnce(pdf("a.pdf")).mockRejectedValueOnce(new Error("db down"))
    const r = await attachMyFilesToChat(IDS, caller)
    expect(r.ok).toBe(false)
    if (r.ok !== false) return
    expect(r.error).not.toMatch(/db down/)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe("removeChatCopies", () => {
  it("removes the named objects from assets; nothing to remove does nothing", async () => {
    await removeChatCopies([])
    expect(remove).not.toHaveBeenCalled()
    await removeChatCopies(["team-chat/claude/x.pdf"])
    expect(remove).toHaveBeenCalledWith("assets", ["team-chat/claude/x.pdf"])
  })

  it("never throws, even when the storage call fails", async () => {
    remove.mockRejectedValueOnce(new Error("network"))
    await expect(removeChatCopies(["team-chat/claude/x.pdf"])).resolves.toBeUndefined()
  })
})
