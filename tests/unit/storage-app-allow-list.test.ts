import { describe, it, expect } from "vitest"
import { parseAllowList, isOnAllowList } from "@/lib/storage-app/allow-list"

describe("who may use the Mac app (a setting that fails closed)", () => {
  it("reads a list of emails, lower-cased and trimmed", () => {
    expect(parseAllowList([" Antonio.Durante@TonyDurante.us ", "luca@tonydurante.us"])).toEqual(["antonio.durante@tonydurante.us", "luca@tonydurante.us"])
  })
  it("anything that is not a list of emails means NOBODY", () => {
    for (const bad of [null, undefined, "antonio@x.us", 5, {}, { 0: "a@b.c" }, [], [1, 2], [null], ["no-at-sign"], [""]]) expect(parseAllowList(bad as unknown)).toEqual([])
  })
  it("ignores junk entries but keeps the good ones", () => {
    expect(parseAllowList(["a@b.c", 7, null, "junk", "D@E.F"])).toEqual(["a@b.c", "d@e.f"])
  })
  it("matches an email exactly, ignoring case — never a prefix or a domain", () => {
    const list = ["luca@tonydurante.us"]
    expect(isOnAllowList("LUCA@tonydurante.us", list)).toBe(true)
    expect(isOnAllowList("luca@tonydurante.us.evil.example", list)).toBe(false)
    expect(isOnAllowList("xluca@tonydurante.us", list)).toBe(false)
    expect(isOnAllowList("jodi@tonydurante.us", list)).toBe(false)
    expect(isOnAllowList("", list)).toBe(false)
    expect(isOnAllowList(null, list)).toBe(false)
    expect(isOnAllowList("luca@tonydurante.us", [])).toBe(false)
  })
})
