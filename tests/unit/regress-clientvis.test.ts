import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { sameNameLockRefusal } from "@/lib/crm-store/new-version-rules"
import { chatAttachmentHeaders } from "@/lib/crm-store/serve"
import { saveWithReplacement, walkChainToEnd, type ChainHead } from "@/lib/crm-store/replacement"
import { StoreLockedFileError } from "@/lib/crm-store/lock-errors"
import { reshowFailedNote } from "@/lib/crm-store/new-version"
import { isOwnPortalUpload, listDocsWithOwnUploads, type ClientStoreDeps } from "@/lib/portal/client-store-docs"
import type { WriteResult } from "@/lib/crm-store/writer"

describe("same-name upload over a locked file (task 1)", () => {
  it("refuses a signed / passport / replaced / amended / filed file in plain words, before anything is hidden", () => {
    for (const k of ["signed", "replace_only", "replaced", "amended", "filed"]) {
      const r = sameNameLockRefusal(k, "Lease.pdf")
      expect(r).toBeTruthy()
      expect(r).not.toMatch(/store:/)
      expect(r).toMatch(/another name/)
    }
  })
  it("a file that takes a new version is not refused", () => {
    expect(sameNameLockRefusal(null, "a.pdf")).toBeNull()
    expect(sameNameLockRefusal(undefined, "a.pdf")).toBeNull()
  })
})

describe("chat attachment headers (task 4)", () => {
  it("a PDF is a download (no inline sandboxed viewer), still nosniff", () => {
    const h = chatAttachmentHeaders("application/pdf", "a b.pdf")
    expect(h["Content-Disposition"]).toMatch(/^attachment;/)
    expect(h["Content-Type"]).toBe("application/pdf")
    expect(h["X-Content-Type-Options"]).toBe("nosniff")
  })
  it("an image stays inline and sandboxed", () => {
    const h = chatAttachmentHeaders("image/png", "a.png")
    expect(h["Content-Disposition"]).toMatch(/^inline;/)
    expect(h["Content-Security-Policy"]).toBe("sandbox")
  })
  it("an unknown type is a download", () => {
    const h = chatAttachmentHeaders("text/html", "a.html")
    expect(h["Content-Disposition"]).toMatch(/^attachment;/)
    expect(h["Content-Type"]).toBe("application/octet-stream")
  })
})

describe("replacement chain walk (task 3b)", () => {
  it("follows a long chain to its end", async () => {
    const next = async (id: string) => { const n = Number(id); return n < 40 ? String(n + 1) : null }
    expect(await walkChainToEnd("0", next)).toBe("40")
  })
  it("stops on a loop instead of spinning", async () => {
    const next = async (id: string) => (id === "a" ? "b" : "a")
    expect(await walkChainToEnd("a", next)).toBe("b")
  })
  it("stops at the cap", async () => {
    let n = 0
    const next = async () => String(++n)
    await walkChainToEnd("s", next, 10)
    expect(n).toBe(10)
  })
})

describe("saveWithReplacement — old copy retired, cross-owner (task 3a, 3c)", () => {
  const ok = (id: string): WriteResult => ({ status: "created", fileId: id, versionId: "v", name: id + ".pdf" })
  const head = (over: Partial<ChainHead> = {}): ChainHead => ({ fileId: "old", ownerId: "o1", versionId: "vo", sha256: "x", name: "old.pdf", live: true, documentType: "t", periodYear: null, ...over })

  it("hides the replaced file's CRM row after the replacement is saved", async () => {
    const retire = vi.fn(async () => {})
    const save = vi.fn(async (a: { callerKey: string }) => { if (a.callerKey === "k") throw new StoreLockedFileError("signed"); return ok("new") })
    const r = await saveWithReplacement({ baseKey: "k", bytes: Buffer.from("B"), name: "n.pdf", save, ownerId: "o1", deps: { chainHead: async () => head(), retire } })
    expect(r.replacedFileId).toBe("old")
    expect(retire).toHaveBeenCalledWith("old")
  })
  it("a failed retire never loses the new copy", async () => {
    const save = vi.fn(async (a: { callerKey: string }) => { if (a.callerKey === "k") throw new StoreLockedFileError("signed"); return ok("new") })
    const r = await saveWithReplacement({ baseKey: "k", bytes: Buffer.from("B"), name: "n.pdf", save, deps: { chainHead: async () => head(), retire: async () => { throw new Error("boom") } } })
    expect(r.status).toBe("created")
  })
  it("a file in ANOTHER owner is not replaced — a fresh file is saved (no supersedes, no error, no retire)", async () => {
    const retire = vi.fn(async () => {})
    const calls: Array<{ callerKey: string; supersedesFileId: string | null; name: string }> = []
    const save = vi.fn(async (a: { callerKey: string; supersedesFileId: string | null; name: string }) => { calls.push(a); if (a.callerKey === "k") throw new StoreLockedFileError("signed"); return ok("fresh") })
    const r = await saveWithReplacement({ baseKey: "k", bytes: Buffer.from("B"), name: "n.pdf", save, ownerId: "o2", deps: { chainHead: async () => head({ ownerId: "o1" }), retire } })
    expect(r.fileId).toBe("fresh")
    expect(calls[1].supersedesFileId).toBeNull()
    expect(calls[1].name).toBe("n.pdf")
    expect(retire).not.toHaveBeenCalled()
  })
})

describe("new version: a failed re-show tells staff (task 5b)", () => {
  it("says the file stays hidden and why", () => {
    expect(reshowFailedNote(new Error("Give this file a document type before showing it to the client."))).toMatch(/^The file stays hidden from the client: Give this file a document type/)
    expect(reshowFailedNote("x")).toMatch(/stays hidden/)
  })
})

describe("the client's own upload on the Tax page (task 2)", () => {
  const ACC = "acc-1"
  it("isOwnPortalUpload: own key + own creator (or an old file with no creator)", () => {
    expect(isOwnPortalUpload({ callerKey: `portal-upload:${ACC}:company:3:abc`, createdBy: "u1", state: "live" }, "u1", ACC)).toBe(true)
    expect(isOwnPortalUpload({ callerKey: `portal-upload:${ACC}:company:3:abc`, createdBy: null, state: "live" }, "u1", ACC)).toBe(true)
    expect(isOwnPortalUpload({ callerKey: `portal-upload:${ACC}:company:3:abc`, createdBy: "u2", state: "live" }, "u1", ACC)).toBe(false)
    expect(isOwnPortalUpload({ callerKey: `portal-upload:other:company:3:abc`, createdBy: "u1", state: "live" }, "u1", ACC)).toBe(false)
    expect(isOwnPortalUpload({ callerKey: "staff-upload:1", createdBy: "u1", state: "live" }, "u1", ACC)).toBe(false)
    expect(isOwnPortalUpload({ callerKey: `portal-upload:${ACC}:company:3:abc`, createdBy: "u1", state: "trashed" }, "u1", ACC)).toBe(false)
  })

  const deps = (over: Partial<ClientStoreDeps> = {}): ClientStoreDeps => ({
    serviceTypes: async () => new Map(), closed: async () => new Set(), personalOutsidePerson: async () => new Set(),
    ownUploads: async () => new Set(["store:11111111-1111-1111-1111-111111111111"]), ...over,
  })
  const rows = [
    { id: "r-own", drive_file_id: "store:11111111-1111-1111-1111-111111111111", portal_visible: false, category: 3, contact_id: null, created_at: "2026-10-25" },
    { id: "r-staff", drive_file_id: "store:22222222-2222-2222-2222-222222222222", portal_visible: false, category: 3, contact_id: null, created_at: "2026-10-24" },
    { id: "r-shown", drive_file_id: "store:33333333-3333-3333-3333-333333333333", portal_visible: true, category: 3, contact_id: null, created_at: "2026-10-23" },
  ]
  const viewer = { contactId: "c1", userId: "u1", accountId: ACC }

  it("keeps the shown file, adds the client's own hidden upload marked waiting, hides the staff draft", async () => {
    const r = await listDocsWithOwnUploads(rows, viewer, deps())
    expect(r.docs.map((d) => d.id)).toEqual(["r-own", "r-shown"])
    expect([...r.waitingIds]).toEqual(["r-own"])
  })
  it("an upload staff made staff-only (closed) stays hidden", async () => {
    const r = await listDocsWithOwnUploads(rows, viewer, deps({ closed: async () => new Set(["store:11111111-1111-1111-1111-111111111111"]) }))
    expect(r.docs.map((d) => d.id)).toEqual(["r-shown"])
    expect(r.waitingIds.size).toBe(0)
  })
  it("another member's personal paper stays hidden", async () => {
    const r = await listDocsWithOwnUploads([{ ...rows[0], category: 2, contact_id: "someone-else" }], viewer, deps())
    expect(r.docs).toEqual([])
  })
})
