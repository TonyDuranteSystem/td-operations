import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The one resolver that decides what may be attached to an outbound email.
 *
 * What these pin:
 *  - a file posted in a conversation (public `assets` bucket) becomes attachable
 *    — the case Luca reported twice — and its BYTES are copied into the private
 *    bucket at prepare, so the frozen draft holds what the human approves rather
 *    than a pointer at something that can change underneath it;
 *  - the model still never names a location: it names a ref the server minted;
 *  - an untrusted host is refused (the SSRF boundary is not optional);
 *  - a mime type off a chat row is shape-checked before it can reach a header;
 *  - size refusals read like Gmail's limit, not an invented policy of ours.
 */

const uploadSpy = vi.hoisted(() => vi.fn())
const fetchedUrls = vi.hoisted(() => [] as string[])
const fetchBytes = vi.hoisted(() => ({ value: Buffer.from("hello world") }))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        upload: async (path: string, bytes: Buffer, opts: unknown) => {
          uploadSpy(path, bytes, opts)
          return { data: { path }, error: null }
        },
      }),
    },
  },
}))

vi.mock("@/lib/ai-agent/attachment-reader", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-agent/attachment-reader")>(
    "@/lib/ai-agent/attachment-reader",
  )
  return {
    ...actual,
    // The real fetcher's host allow-list is exercised by its own tests; here we
    // only need to know the resolver goes THROUGH it (and honours its refusal).
    fetchTrustedStorageBytes: async (ref: { id: string }) => {
      fetchedUrls.push(ref.id)
      if (!ref.id.includes("ydzipybqeebtpcvsbtvs.supabase.co")) throw new Error(`untrusted host`)
      return fetchBytes.value
    },
  }
})

import {
  materializeSendable,
  sendableFromChatRefs,
  attachableFilesPrompt,
  SendableRefusal,
  type SendableFile,
} from "@/lib/inbox/sendable-attachment"

const CAP = 18 * 1024 * 1024
const teamChatUrl =
  "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/team-chat/e2816056-7e71-46ba-8306-675ffd33c5d6/d9f25bfd-f73d-457a-a68e-e3f1152dbf9c.pdf"

const chatFile: SendableFile = {
  ref: "f1",
  source: "chat_asset",
  locator: teamChatUrl,
  name: "EIN Letter (IRS) - Flowiz studio LLC.pdf",
  contentType: "application/pdf",
  size: 15_253,
  origin: "posted in this message",
}

beforeEach(() => {
  uploadSpy.mockClear()
  fetchedUrls.length = 0
  fetchBytes.value = Buffer.from("hello world")
})

describe("materializeSendable — a file posted in a conversation", () => {
  it("copies it into the PRIVATE bucket and freezes that path (Luca's reported case)", async () => {
    const out = await materializeSendable(chatFile, CAP)
    expect(fetchedUrls).toEqual([teamChatUrl])
    // The frozen location is ours, in the shape the confirm path already accepts.
    expect(out.path).toMatch(/^worker-chat\/[0-9a-f-]{36}\.pdf$/)
    expect(uploadSpy).toHaveBeenCalledOnce()
    expect(out.name).toBe(chatFile.name)
    expect(out.origin).toBe("posted in this message")
  })

  it("records the ACTUAL byte length, not the size declared on the chat row", async () => {
    fetchBytes.value = Buffer.alloc(4321)
    const out = await materializeSendable(chatFile, CAP)
    expect(out.size).toBe(4321)
  })

  it("REFUSES a file from a host that is not our storage (the SSRF boundary holds)", async () => {
    const evil = { ...chatFile, locator: "https://attacker.example.com/x.pdf" }
    await expect(materializeSendable(evil, CAP)).rejects.toBeInstanceOf(SendableRefusal)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it("SHAPE-CHECKS the mime type off the chat row before it can reach a MIME header", async () => {
    const poisoned = { ...chatFile, contentType: "application/pdf\r\nBcc: someone@else.com" }
    const out = await materializeSendable(poisoned, CAP)
    expect(out.content_type).toBe("application/octet-stream")
  })

  it("refuses an oversize file in Gmail's terms — and copies nothing", async () => {
    fetchBytes.value = Buffer.alloc(64)
    await expect(materializeSendable(chatFile, 32)).rejects.toThrow(/Gmail won't accept an email that big/)
    expect(uploadSpy).not.toHaveBeenCalled()
  })
})

describe("materializeSendable — a panel upload", () => {
  it("uses it in place (nothing is copied) — it is already ours and already private", async () => {
    const upload: SendableFile = {
      ref: "up1",
      source: "worker_upload",
      locator: "worker-chat/0f8fad5b-d9cb-469f-a165-70867728950e.pdf",
      name: "affidavit.pdf",
      size: 400,
    }
    const out = await materializeSendable(upload, CAP)
    expect(out.path).toBe(upload.locator)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it("REFUSES a path outside the private bucket's own shape (no traversal, no other bucket)", async () => {
    const bad: SendableFile = {
      ref: "up1",
      source: "worker_upload",
      locator: "signed-documents/secret.pdf",
      name: "secret.pdf",
    }
    await expect(materializeSendable(bad, CAP)).rejects.toBeInstanceOf(SendableRefusal)
  })
})

describe("sendableFromChatRefs / attachableFilesPrompt", () => {
  it("mints sequential refs and can start after another surface's refs, so two sets never collide", () => {
    const files = sendableFromChatRefs(
      [{ id: "u1", name: "a.pdf" }, { id: "u2", name: "b.pdf" }],
      "posted in this client's chat",
      3,
    )
    expect(files.map((f) => f.ref)).toEqual(["f3", "f4"])
    expect(files.every((f) => f.source === "chat_asset")).toBe(true)
  })

  it("tells the worker the ref, the name and where the file came from — and never a URL", () => {
    const line = attachableFilesPrompt([chatFile])
    expect(line).toContain("f1 — EIN Letter (IRS) - Flowiz studio LLC.pdf (posted in this message)")
    expect(line).not.toContain("supabase.co")
  })

  it("says nothing at all when there is nothing to attach (no false capability)", () => {
    expect(attachableFilesPrompt([])).toBe("")
  })
})
