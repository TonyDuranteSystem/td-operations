import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { lockKindFromDbError, plainStoreError, isLockRefusal, StoreLockedFileError } from "@/lib/crm-store/lock-errors"
import { saveWithReplacement, replacementKey, replacementName, type ChainHead } from "@/lib/crm-store/replacement"
import { StoreFrozenFileError, sha256Hex, type WriteResult } from "@/lib/crm-store/writer"

describe("lockKindFromDbError", () => {
  it("reads the trigger's DETAIL", () => {
    expect(lockKindFromDbError({ message: "store: a passport…", details: "lock:replace_only", code: "23514" })).toBe("replace_only")
    expect(lockKindFromDbError({ message: "x", details: "lock:signed" })).toBe("signed")
    expect(lockKindFromDbError({ message: "x", details: "lock:replaced" })).toBe("replaced")
    expect(lockKindFromDbError({ message: "x", details: "lock:amended" })).toBe("amended")
  })
  it("falls back to the message wording", () => {
    expect(lockKindFromDbError({ message: "store: this is a signed document and cannot be changed in place — add a replacement file instead" })).toBe("signed")
    expect(lockKindFromDbError({ message: "store: a passport or ID is never edited in place — add a replacement file instead" })).toBe("replace_only")
  })
  it("is null for anything else", () => {
    expect(lockKindFromDbError(null)).toBeNull()
    expect(lockKindFromDbError({ message: "duplicate key value", details: "Key (x)=(1) already exists." })).toBeNull()
  })
})

describe("plainStoreError — raw 'store:' text never reaches staff", () => {
  it("a locked file gets the lock sentence", () => {
    expect(plainStoreError(new StoreLockedFileError("signed", "Lease.pdf"))).toMatch(/"Lease.pdf" was signed/)
    expect(plainStoreError(new StoreLockedFileError("replace_only", "Passport.pdf"))).toMatch(/passport or ID/)
    expect(plainStoreError(new StoreLockedFileError("amended", "R.pdf"))).toMatch(/amended return/)
  })
  it("a filed return gets the filed sentence", () => {
    expect(plainStoreError(new StoreFrozenFileError("f1", "1120.pdf"))).toMatch(/filed return/)
  })
  it("a wrapped store error is replaced by the fallback", () => {
    const r = plainStoreError(new Error("store: could not register the file — boom"), "Plain fallback.")
    expect(r).toBe("Plain fallback.")
    expect(r).not.toMatch(/store:/)
  })
  it("a wrapped lock message is recognised", () => {
    expect(plainStoreError(new Error("store: could not register the file — store: a passport or ID is never edited in place"))).toMatch(/passport or ID/)
  })
  it("a sentence our own code wrote for people passes through", () => {
    expect(plainStoreError(new Error("This company's files are being moved right now."))).toBe("This company's files are being moved right now.")
  })
  it("a non-error gets the fallback", () => {
    expect(plainStoreError("weird", "Fallback.")).toBe("Fallback.")
  })
  it("isLockRefusal", () => {
    expect(isLockRefusal(new StoreLockedFileError("signed"))).toBe(true)
    expect(isLockRefusal(new StoreFrozenFileError("f", "n"))).toBe(true)
    expect(isLockRefusal(new Error("x"))).toBe(false)
  })
})

describe("replacement key and name", () => {
  it("key = base key + first 8 hex of the sha", () => {
    expect(replacementKey("lease-signed:abc", "0123456789abcdef")).toBe("lease-signed:abc:01234567")
  })
  it("name gets the date and keeps the extension", () => {
    expect(replacementName("Lease (Suite 4).pdf", new Date("2026-10-25T10:00:00Z"))).toBe("Lease (Suite 4) (new copy 2026-10-25).pdf")
    expect(replacementName("noext", new Date("2026-10-25T10:00:00Z"))).toBe("noext (new copy 2026-10-25)")
  })
})

describe("saveWithReplacement", () => {
  const ok = (id: string, status: WriteResult["status"] = "created"): WriteResult => ({ status, fileId: id, versionId: "v-" + id, name: id + ".pdf" })
  const head = (over: Partial<ChainHead> = {}): ChainHead => ({ fileId: "old", versionId: "vo", sha256: "x", name: "old.pdf", live: true, documentType: "passport", periodYear: null, ...over })

  it("a normal save needs no replacement", async () => {
    const save = vi.fn(async () => ok("a"))
    const r = await saveWithReplacement({ baseKey: "k", bytes: Buffer.from("A"), name: "n.pdf", save, deps: { chainHead: vi.fn() } })
    expect(r.fileId).toBe("a")
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("a locked original with CHANGED bytes → a new file that replaces the newest copy, with the old type", async () => {
    const calls: Array<{ callerKey: string; supersedesFileId: string | null; name: string; documentType?: string | null }> = []
    const save = vi.fn(async (a) => { calls.push(a); if (a.callerKey === "k") throw new StoreLockedFileError("replace_only", "n.pdf"); return ok("new") })
    const bytes = Buffer.from("SCAN-B")
    const r = await saveWithReplacement({ baseKey: "k", bytes, name: "n.pdf", save, deps: { chainHead: async () => head() }, now: new Date("2026-10-25T00:00:00Z") })
    expect(r.status).toBe("created")
    expect(r.replacedFileId).toBe("old")
    expect(calls[1]).toMatchObject({ callerKey: `k:${sha256Hex(bytes).slice(0, 8)}`, supersedesFileId: "old", name: "n (new copy 2026-10-25).pdf", documentType: "passport" })
  })

  it("a locked original with the SAME bytes as the newest copy → unchanged, nothing new saved", async () => {
    const bytes = Buffer.from("SAME")
    const save = vi.fn(async (a) => { if (a.callerKey === "k") throw new StoreLockedFileError("signed"); return ok("new") })
    const r = await saveWithReplacement({ baseKey: "k", bytes, name: "n.pdf", save, deps: { chainHead: async () => head({ sha256: sha256Hex(bytes), fileId: "newest" }) } })
    expect(r).toMatchObject({ status: "unchanged", fileId: "newest" })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("a filed (frozen) original is handled the same way", async () => {
    const save = vi.fn(async (a) => { if (a.callerKey === "k") throw new StoreFrozenFileError("f", "n.pdf"); return ok("new") })
    const r = await saveWithReplacement({ baseKey: "k", bytes: Buffer.from("Z"), name: "n.pdf", save, deps: { chainHead: async () => head() } })
    expect(r.status).toBe("created")
  })

  it("nothing live to replace → the original refusal is thrown (the caller reports it in plain words)", async () => {
    const save = vi.fn(async () => { throw new StoreLockedFileError("signed") })
    await expect(saveWithReplacement({ baseKey: "k", bytes: Buffer.from("Z"), name: "n.pdf", save, deps: { chainHead: async () => head({ live: false }) } })).rejects.toBeInstanceOf(StoreLockedFileError)
    await expect(saveWithReplacement({ baseKey: "k", bytes: Buffer.from("Z"), name: "n.pdf", save, deps: { chainHead: async () => null } })).rejects.toBeInstanceOf(StoreLockedFileError)
  })

  it("any other error is not swallowed", async () => {
    const save = vi.fn(async () => { throw new Error("store: upload failed — x") })
    await expect(saveWithReplacement({ baseKey: "k", bytes: Buffer.from("Z"), name: "n.pdf", save, deps: { chainHead: vi.fn() } })).rejects.toThrow(/upload failed/)
  })
})
