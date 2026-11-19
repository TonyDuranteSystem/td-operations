import { describe, it, expect } from "vitest"
import { buildRoutes, parseOwnerList, MAX_OWNERS_PER_QUESTION } from "@/lib/storage-app/routes"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const isId = (s: string) => /^[0-9a-f-]{36}$/.test(s)

describe("company routes for a person's storage (the Mac updates the copy under each company)", () => {
  const folders = new Map([[id(1), "f1"], [id(2), "f2"], [id(3), "f3"]])

  it("one route per company that lists the person, each with the company's Contacts folder", () => {
    expect(buildRoutes("P", [id(2), id(1)], folders, () => true)).toEqual([
      { owner: "P", company: id(1), folder: "f1" },
      { owner: "P", company: id(2), folder: "f2" },
    ])
  })
  it("a company listed twice gives one route", () => {
    expect(buildRoutes("P", [id(1), id(1)], folders, () => true)).toHaveLength(1)
  })
  it("a company with no Contacts folder gives nothing", () => {
    expect(buildRoutes("P", [id(9)], folders, () => true)).toEqual([])
  })
  it("a company this login may not open is left out — it is never named", () => {
    expect(buildRoutes("P", [id(1), id(2)], folders, (c) => c === id(2))).toEqual([{ owner: "P", company: id(2), folder: "f2" }])
  })
  it("no companies, no routes", () => {
    expect(buildRoutes("P", [], folders, () => true)).toEqual([])
  })
})

describe("?owner=a,b,c", () => {
  it("keeps valid ids once each and drops the rest", () => {
    expect(parseOwnerList(`${id(1)}, ${id(2)},${id(1)},nope,`, isId)).toEqual([id(1), id(2)])
  })
  it("nothing in, nothing out", () => {
    expect(parseOwnerList(null, isId)).toEqual([])
    expect(parseOwnerList("", isId)).toEqual([])
  })
  it("never more than the limit per question", () => {
    const many = Array.from({ length: MAX_OWNERS_PER_QUESTION + 20 }, (_, i) => id(i + 1)).join(",")
    expect(parseOwnerList(many, isId)).toHaveLength(MAX_OWNERS_PER_QUESTION)
  })
})
