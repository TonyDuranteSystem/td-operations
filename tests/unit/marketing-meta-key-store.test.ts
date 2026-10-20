import { describe, it, expect } from "vitest"
import { decryptPageKey, encryptPageKey } from "@/lib/marketing/meta-leads/key-crypto"
import { listConnections, readStoredKey, saveStoredKey } from "@/lib/marketing/meta-leads/key-store"
import { FakeDb } from "./helpers/fake-lead-db"

const SECRET = "app-secret-one"
const KEY = "EAAB-this-is-a-long-page-key-0123456789"

describe("key-crypto", () => {
  it("round-trips and never contains the plain key", () => {
    const blob = encryptPageKey(KEY, SECRET)
    expect(blob.startsWith("v1.")).toBe(true)
    expect(blob).not.toContain(KEY)
    expect(blob).not.toContain("EAAB")
    expect(decryptPageKey(blob, SECRET)).toBe(KEY)
  })
  it("uses a fresh random IV each time", () => {
    expect(encryptPageKey(KEY, SECRET)).not.toBe(encryptPageKey(KEY, SECRET))
  })
  it("a different secret, a tampered value or a wrong format decrypts to null (never throws)", () => {
    const blob = encryptPageKey(KEY, SECRET)
    expect(decryptPageKey(blob, "another-secret")).toBeNull()
    const parts = blob.split("."); parts[3] = parts[3].slice(0, -2) + "AA"
    expect(decryptPageKey(parts.join("."), SECRET)).toBeNull()
    for (const bad of ["", "v2.a.b.c", "nonsense", "v1.a.b", null, undefined]) expect(decryptPageKey(bad as string, SECRET)).toBeNull()
    expect(decryptPageKey(blob, "")).toBeNull()
  })
  it("refuses to encrypt without a secret or a key", () => {
    expect(() => encryptPageKey(KEY, "")).toThrow(/app secret/)
    expect(() => encryptPageKey("", SECRET)).toThrow()
  })
})

describe("key-store", () => {
  const input = { pageId: "101", pageName: "Tony Durante LLC", key: KEY, userId: "u1", userName: "Tony Durante", longLived: true, connectedBy: "antonio@x.us" }
  it("saves encrypted, reads back the key, and lists without it", async () => {
    const db = new FakeDb()
    expect(await saveStoredKey(db, SECRET, input)).toBeNull()
    expect(JSON.stringify(db.rows("marketing_meta_connection"))).not.toContain(KEY)
    expect(await readStoredKey(db, SECRET, "101")).toEqual({ pageId: "101", key: KEY })
    expect(await readStoredKey(db, SECRET)).toEqual({ pageId: "101", key: KEY })
    const list = await listConnections(db, SECRET)
    expect(list[0]).toMatchObject({ pageId: "101", pageName: "Tony Durante LLC", longLived: true, readable: true, connectedBy: "antonio@x.us" })
    expect(JSON.stringify(list)).not.toContain("EAAB")
  })
  it("saving again replaces the key (one row per Page)", async () => {
    const db = new FakeDb()
    await saveStoredKey(db, SECRET, input)
    await saveStoredKey(db, SECRET, { ...input, key: "EAAB-new-key-9999999999" })
    expect(db.rows("marketing_meta_connection")).toHaveLength(1)
    expect((await readStoredKey(db, SECRET, "101"))?.key).toBe("EAAB-new-key-9999999999")
  })
  it("a changed app secret makes the stored key unreadable: the list says so and reads return null", async () => {
    const db = new FakeDb()
    await saveStoredKey(db, SECRET, input)
    expect(await readStoredKey(db, "changed-secret", "101")).toBeNull()
    expect((await listConnections(db, "changed-secret"))[0].readable).toBe(false)
  })
  it("never guesses when several Pages are stored and none is named", async () => {
    const db = new FakeDb()
    await saveStoredKey(db, SECRET, input)
    await saveStoredKey(db, SECRET, { ...input, pageId: "202", pageName: "Other" })
    expect(await readStoredKey(db, SECRET)).toBeNull()
    expect((await readStoredKey(db, SECRET, "202"))?.pageId).toBe("202")
  })
  it("nothing stored, or a database error, reads as null and never throws", async () => {
    const db = new FakeDb()
    expect(await readStoredKey(db, SECRET, "101")).toBeNull()
    db.failTables.add("marketing_meta_connection")
    expect(await readStoredKey(db, SECRET, "101")).toBeNull()
    expect(await listConnections(db, SECRET)).toEqual([])
  })
  it("saving without an app secret fails in plain words", async () => {
    expect(await saveStoredKey(new FakeDb(), "", input)).toMatch(/app secret/)
  })
  it("a missing table says to run the SQL first", async () => {
    const db = new FakeDb(); db.failTables.add("marketing_meta_connection")
    // the fake reports "forced failure"; a real missing table reports "relation ... does not exist": the message mapping is checked in the connect tests
    expect(await saveStoredKey(db, SECRET, input)).toMatch(/could not be saved|does not exist/)
  })
})
