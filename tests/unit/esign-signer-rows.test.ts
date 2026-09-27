import { describe, it, expect } from "vitest"
import { buildSignerRows } from "@/lib/esign/signer-rows"

const michele = { id: "c-mc", full_name: "Michele Cotti", email: "m@whalecot.com" }
const names = new Map<string, string | null>([
  ["a-ai", "AI Venture Labs LLC"],
  ["a-cm", "Conversion Monsters LLC"],
  ["a-wh", "Whalecot Consulting LLC"],
])
const micheleLinks = [
  { contact_id: "c-mc", account_id: "a-ai" },
  { contact_id: "c-mc", account_id: "a-cm" },
  { contact_id: "c-mc", account_id: "a-wh" },
]

describe("buildSignerRows", () => {
  it("returns one row per company plus a personal row — never collapses to one company", () => {
    const rows = buildSignerRows({ contacts: [michele], links: micheleLinks, accountNames: names, matchedAccountIds: new Set() })
    expect(rows.map(r => r.company_name)).toEqual([
      "AI Venture Labs LLC",
      "Conversion Monsters LLC",
      "Whalecot Consulting LLC",
      null,
    ])
    expect(rows.every(r => r.contact_id === "c-mc" && r.email === "m@whalecot.com")).toBe(true)
    expect(rows[3].account_id).toBeNull()
    expect(new Set(rows.map(r => r.key)).size).toBe(4)
  })

  it("puts the company that matched the search on top (the Whalecot regression)", () => {
    const rows = buildSignerRows({ contacts: [michele], links: micheleLinks, accountNames: names, matchedAccountIds: new Set(["a-wh"]) })
    expect(rows[0]).toMatchObject({ account_id: "a-wh", company_name: "Whalecot Consulting LLC", company_match: true })
    expect(rows).toHaveLength(4)
  })

  it("does not cap rows for a person with many companies", () => {
    const links = Array.from({ length: 12 }, (_, i) => ({ contact_id: "c-mc", account_id: `a${i}` }))
    const rows = buildSignerRows({ contacts: [michele], links, accountNames: new Map(), matchedAccountIds: new Set() })
    expect(rows).toHaveLength(13)
  })

  it("a contact with no company gets only the personal row", () => {
    const rows = buildSignerRows({ contacts: [{ id: "c1", full_name: "Solo", email: null }], links: [], accountNames: new Map(), matchedAccountIds: new Set() })
    expect(rows).toEqual([{ key: "c1:personal", contact_id: "c1", full_name: "Solo", email: null, account_id: null, company_name: null, company_match: false }])
  })

  it("dedupes repeated contacts and repeated links", () => {
    const rows = buildSignerRows({
      contacts: [michele, michele],
      links: [...micheleLinks, micheleLinks[0]],
      accountNames: names,
      matchedAccountIds: new Set(),
    })
    expect(rows).toHaveLength(4)
  })

  it("orders several people by name, company rows before the personal row", () => {
    const rows = buildSignerRows({
      contacts: [{ id: "c-z", full_name: "Zed", email: null }, { id: "c-a", full_name: "Anna", email: null }],
      links: [{ contact_id: "c-a", account_id: "a-ai" }, { contact_id: "c-z", account_id: "a-cm" }],
      accountNames: names,
      matchedAccountIds: new Set(),
    })
    expect(rows.map(r => r.key)).toEqual(["c-a:a-ai", "c-a:personal", "c-z:a-cm", "c-z:personal"])
  })

  it("handles null names/emails and unknown account names", () => {
    const rows = buildSignerRows({
      contacts: [{ id: "c1", full_name: null, email: null }],
      links: [{ contact_id: "c1", account_id: "a-missing" }],
      accountNames: new Map(),
      matchedAccountIds: new Set(),
    })
    expect(rows[0]).toMatchObject({ full_name: "", email: null, account_id: "a-missing", company_name: null })
  })
})
