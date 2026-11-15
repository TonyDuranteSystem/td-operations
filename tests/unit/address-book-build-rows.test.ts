import { describe, it, expect } from "vitest"
import { buildRows, companyOf, crmMatches, kindOfContact, linksByContact, savedCountByType, type AccountIn, type ContactIn, type CrmInputs, type EntryIn, type LabelIn, type LinkIn, type PartnerIn } from "@/lib/address-book/build-rows"
import { chipCounts, type TypeDto } from "@/lib/address-book/people"

const SUP = "11111111-1111-4111-8111-111111111111"
const HIDDEN = "22222222-2222-4222-8222-222222222222"
const type = (id: string, name: string, hidden = false): TypeDto => ({ id, slug: name.toLowerCase(), name, color: null, sortOrder: 0, boxes: [], hidden, savedCount: 0 })
const TYPES = [type(SUP, "Supplier"), type(HIDDEN, "Lawyer", true)]

const contact = (id: string, over: Partial<ContactIn> = {}): ContactIn => ({
  id,
  full_name: `Person ${id}`,
  email: null,
  email_2: null,
  alt_emails: null,
  phone: null,
  phone_2: null,
  phone_3: null,
  phone_4: null,
  portal_tier: null,
  created_at: null,
  ...over,
})
const account = (id: string, over: Partial<AccountIn> = {}): AccountIn => ({ id, company_name: `Co ${id}`, account_type: "Client", status: "Active", ...over })
const link = (account_id: string, contact_id: string, over: Partial<LinkIn> = {}): LinkIn => ({ account_id, contact_id, is_primary: false, ended_at: null, ...over })
const partner = (id: string, over: Partial<PartnerIn> = {}): PartnerIn => ({ id, partner_name: `Partner ${id}`, company: "Bank Co", partner_type: "Banking Partner", email: null, secondary_email: null, phone: null, service_area: null, created_at: null, ...over })
const entry = (id: string, over: Partial<EntryIn> = {}): EntryIn => ({ id, full_name: `Saved ${id}`, company: null, job_title: null, website: null, phones: [], emails: [], address: null, notes: null, extra: {}, type_entry_id: null, source: "typed", created_at: null, ...over })

function inputs(over: Partial<CrmInputs & { labels: LabelIn[]; entries: EntryIn[] }> = {}) {
  return { contacts: [], accounts: [], links: [], partners: [], labels: [], entries: [], types: TYPES, ...over }
}

describe("buildRows", () => {
  it("builds one row per contact, partner and saved person, sorted by name without accents or case", () => {
    const rows = buildRows(
      inputs({
        contacts: [contact("c1", { full_name: "Zed Last" }), contact("c2", { full_name: "élodie First" })],
        partners: [partner("p1", { partner_name: "Mia Banker" })],
        entries: [entry("e1", { full_name: "Anna Saved" })],
      }),
    )
    expect(rows.map((r) => r.name)).toEqual(["Anna Saved", "élodie First", "Mia Banker", "Zed Last"])
    expect(rows.map((r) => r.key).sort()).toEqual(["contact:c1", "contact:c2", "partner:p1", "saved:e1"])
  })

  it("a contact shows its company, first phone and first email, and is searchable by every phone and email", () => {
    const rows = buildRows(
      inputs({
        contacts: [contact("c1", { phone: null, phone_2: "+1 555 010 0100", email: null, alt_emails: ["Old@Mail.co"], portal_tier: "active" })],
        accounts: [account("a1", { company_name: "Ferrante Studio LLC" })],
        links: [link("a1", "c1")],
      }),
    )
    expect(rows[0].company).toBe("Ferrante Studio LLC")
    expect(rows[0].phone).toBe("+1 555 010 0100")
    expect(rows[0].email).toBe("Old@Mail.co")
    expect(rows[0].crmKind).toBe("company")
    expect(rows[0].search).toContain("15550100100")
    expect(rows[0].search).toContain("old@mail.co")
  })

  it("a link to a test account (not loaded) does not count: the person is then judged by their portal level", () => {
    const rows = buildRows(inputs({ contacts: [contact("c1", { portal_tier: "lead" })], accounts: [], links: [link("a-test", "c1")] }))
    expect(rows[0].crmKind).toBe("lead")
    expect(rows[0].company).toBeNull()
  })

  it("partners: Banking Partner = banker, the Partners page's service area is kept", () => {
    const rows = buildRows(inputs({ partners: [partner("p1", { service_area: "Wire questions" }), partner("p2", { partner_type: "RA Provider" })] }))
    expect(rows.find((r) => r.id === "p1")?.crmKind).toBe("banker")
    expect(rows.find((r) => r.id === "p1")?.serviceArea).toBe("Wire questions")
    expect(rows.find((r) => r.id === "p2")?.crmKind).toBe("partner")
  })

  it("a type Antonio confirmed counts for a not-sorted or other person, and takes them out of that chip", () => {
    const rows = buildRows(
      inputs({
        contacts: [contact("c1"), contact("c2", { portal_tier: "onboarding" })],
        labels: [{ subject_kind: "contact", subject_id: "c1", type_entry_id: SUP }, { subject_kind: "contact", subject_id: "c2", type_entry_id: SUP }],
      }),
    )
    expect(rows.every((r) => r.typeId === SUP)).toBe(true)
    const c = chipCounts(rows)
    expect(c.crm.unsorted).toBe(0)
    expect(c.crm.other).toBe(0)
    expect(c.types[SUP]).toBe(2)
  })

  it("a confirmed type is ignored once the CRM sorts the person (a client, a lead, a partner)", () => {
    const rows = buildRows(
      inputs({
        contacts: [contact("c1", { portal_tier: "lead" }), contact("c2", { portal_tier: "active" })],
        accounts: [account("a1")],
        links: [link("a1", "c2")],
        labels: [{ subject_kind: "contact", subject_id: "c1", type_entry_id: SUP }, { subject_kind: "contact", subject_id: "c2", type_entry_id: SUP }],
      }),
    )
    expect(rows.map((r) => r.typeId)).toEqual([null, null])
    expect(rows.map((r) => r.crmKind).sort()).toEqual(["company", "lead"])
  })

  it("a confirmed type that is hidden, or whose type is gone, is ignored: the person is not sorted again", () => {
    const rows = buildRows(
      inputs({
        contacts: [contact("c1"), contact("c2")],
        labels: [{ subject_kind: "contact", subject_id: "c1", type_entry_id: HIDDEN }, { subject_kind: "contact", subject_id: "c2", type_entry_id: null }],
      }),
    )
    expect(rows.map((r) => r.typeId)).toEqual([null, null])
    expect(rows.every((r) => r.crmKind === "unsorted")).toBe(true)
  })

  it("a saved person under a hidden type shows with no type; their details and boxes are kept", () => {
    const rows = buildRows(
      inputs({
        entries: [entry("e1", { type_entry_id: HIDDEN, notes: "Met at the bank event", phones: ["+1 555 010 0188"], emails: ["tom@lakeshore.example"], extra: { renewal: "2027-03-01", cost: 12.5, preferred: true, junk: { a: 1 } } })],
      }),
    )
    expect(rows[0].typeId).toBeNull()
    expect(rows[0].source).toBe("saved")
    expect(rows[0].detail?.notes).toBe("Met at the bank event")
    expect(rows[0].extra).toEqual({ renewal: "2027-03-01", cost: 12.5, preferred: true })
    expect(rows[0].search).toContain("2027-03-01")
  })

  it("a contact with no name still gets a row", () => {
    const rows = buildRows(inputs({ contacts: [contact("c1", { full_name: null })] }))
    expect(rows[0].name).toBe("(no name)")
  })
})

describe("company of a contact", () => {
  const A = account("a1", { company_name: "Beta LLC" })
  const B = account("a2", { company_name: "Alpha LLC", status: "Closed" })
  it("prefers a live Active client company, then the primary one, then the first by name", () => {
    const map = linksByContact([A, B], [link("a1", "c"), link("a2", "c", { is_primary: true })])
    expect(companyOf(map.get("c") ?? [])).toBe("Beta LLC")
  })
  it("a past client still shows the company they had", () => {
    const map = linksByContact([B], [link("a2", "c", { ended_at: "2025-01-01" })])
    expect(companyOf(map.get("c") ?? [])).toBe("Alpha LLC")
  })
  it("no link, no company", () => {
    expect(companyOf([])).toBeNull()
  })
  it("kindOfContact reads the same links", () => {
    const map = linksByContact([A], [link("a1", "c")])
    expect(kindOfContact(contact("c"), map.get("c") ?? [])).toBe("company")
  })
})

describe("who already holds this phone or email", () => {
  const crm: CrmInputs = {
    contacts: [contact("c1", { full_name: "Giulia", phone_3: "+1 (555) 010-0142", alt_emails: ["G@Example.com"], portal_tier: "active" })],
    accounts: [],
    links: [],
    partners: [partner("p1", { partner_name: "Daniela", phone: "555-010-0177", secondary_email: "d@bank.example" })],
  }
  it("finds a contact by any of its phones, however typed, and by any email", () => {
    expect(crmMatches(crm, { phoneKeys: ["15550100142"], emails: [] }).map((m) => m.key)).toEqual(["contact:c1"])
    expect(crmMatches(crm, { phoneKeys: [], emails: ["g@example.com"] }).map((m) => m.key)).toEqual(["contact:c1"])
  })
  it("finds a partner too, and reports what the CRM calls them", () => {
    const m = crmMatches(crm, { phoneKeys: ["5550100177"], emails: [] })
    expect(m).toHaveLength(1)
    expect(m[0].key).toBe("partner:p1")
    expect(m[0].crmKind).toBe("banker")
  })
  it("the same number with or without the country code is the same number, both ways round", () => {
    expect(crmMatches(crm, { phoneKeys: ["5550100142"], emails: [] }).map((m) => m.key)).toEqual(["contact:c1"]) // typed without +1, stored with it
    const noCode: CrmInputs = { ...crm, contacts: [contact("c9", { phone: "555-010-0142" })] }
    expect(crmMatches(noCode, { phoneKeys: ["15550100142", "5550100142"], emails: [] }).map((m) => m.key)).toEqual(["contact:c9"]) // typed with +1, stored without
  })
  it("nothing to look for, nothing found", () => {
    expect(crmMatches(crm, { phoneKeys: [], emails: [] })).toEqual([])
    expect(crmMatches(crm, { phoneKeys: ["99999999"], emails: ["x@y.co"] })).toEqual([])
  })
})

describe("saved count per type", () => {
  it("counts every saved person under their type", () => {
    const m = savedCountByType([entry("1", { type_entry_id: SUP }), entry("2", { type_entry_id: SUP }), entry("3"), entry("4", { type_entry_id: HIDDEN })])
    expect(m.get(SUP)).toBe(2)
    expect(m.get(HIDDEN)).toBe(1)
    expect(m.size).toBe(2)
  })
})
