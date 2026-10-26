import { describe, it, expect } from "vitest"
import { answerForAppend, parseBaseVersionNo, slotBelongsToUpdate, updateCallerKey } from "@/lib/storage-app/update-rules"

const K1 = "11111111-1111-4111-8111-111111111111"
const K2 = "22222222-2222-4222-8222-222222222222"
const FILE_KEY = "storage-app:dev1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

describe("update slots — one slot per update", () => {
  it("two updates of the same file never share a slot key", () => {
    expect(updateCallerKey(FILE_KEY, K1)).not.toBe(updateCallerKey(FILE_KEY, K2))
    expect(updateCallerKey(FILE_KEY, K1.toUpperCase())).toBe(updateCallerKey(FILE_KEY, K1))
  })
  it("a slot belongs only to the update it was made for", () => {
    expect(slotBelongsToUpdate({ slotKey: updateCallerKey(FILE_KEY, K1), fileCallerKey: FILE_KEY, itemKey: K1 })).toBe("match")
    expect(slotBelongsToUpdate({ slotKey: updateCallerKey(FILE_KEY, K1), fileCallerKey: FILE_KEY, itemKey: K2 })).toBe("no")
    expect(slotBelongsToUpdate({ slotKey: "storage-app:other:x", fileCallerKey: FILE_KEY, itemKey: K1 })).toBe("no")
    expect(slotBelongsToUpdate({ slotKey: null, fileCallerKey: FILE_KEY, itemKey: K1 })).toBe("no")
  })
  it("an older-style slot (the file's own key) is usable but never a 'repeat'", () => {
    expect(slotBelongsToUpdate({ slotKey: FILE_KEY, fileCallerKey: FILE_KEY, itemKey: K1 })).toBe("legacy")
  })
})

describe("baseVersionNo", () => {
  it("only a positive whole number counts", () => {
    expect(parseBaseVersionNo(3)).toBe(3)
    for (const bad of [0, -1, 1.5, "3", null, undefined, NaN, 1e9]) expect(parseBaseVersionNo(bad)).toBeNull()
  })
})

describe("answerForAppend — plain answers the shipped Mac app understands", () => {
  const a = (res: Parameters<typeof answerForAppend>[0]) => answerForAppend(res, "f1", "o1", "Notes.txt", 10)
  it("versioned / unchanged are 200 and done", () => {
    expect(a({ status: "versioned", versionNo: 4 })).toMatchObject({ status: 200, done: true, body: { fileId: "f1", outcome: "versioned", versionNo: 4 } })
    expect(a({ status: "unchanged", alreadyApplied: true })).toMatchObject({ status: 200, done: true, body: { outcome: "unchanged", alreadyApplied: true } })
  })
  it("conflict is 409 with plain words and the current version", () => {
    const r = a({ status: "conflict", currentVersionNo: 7 })
    expect(r).toMatchObject({ status: 409, done: false, body: { error: "conflict", currentVersionNo: 7 } })
    expect(String(r.body.message)).toMatch(/Someone else changed "Notes.txt"/)
  })
  it("locked and frozen are 422 (the Mac shows the message and does NOT retry), never 500", () => {
    const l = a({ status: "locked", kind: "signed" })
    expect(l.status).toBe(422)
    expect(l.body).toMatchObject({ error: "locked", kind: "signed" })
    expect(String(l.body.message)).toMatch(/was signed/)
    const f = a({ status: "frozen" })
    expect(f).toMatchObject({ status: 422, body: { error: "frozen" } })
    expect(String(f.body.message)).toMatch(/filed return/)
  })
  it("an amended return asks for the CRM", () => {
    const r = a({ status: "needs_confirmation" })
    expect(r.status).toBe(422)
    expect(String(r.body.message)).toMatch(/Change it in the CRM/)
  })
  it("trashed is 409, an unknown file 404", () => {
    expect(a({ status: "trashed" }).status).toBe(409)
    expect(a({ status: "not_found" }).status).toBe(404)
  })
  it("no answer ever carries a raw code in its message", () => {
    for (const s of ["conflict", "locked", "frozen", "needs_confirmation", "trashed", "not_found", "unmerged"]) {
      const m = String(a({ status: s, kind: "replace_only" }).body.message)
      expect(m).not.toMatch(/store:|check_violation|lock:/)
    }
  })
})
