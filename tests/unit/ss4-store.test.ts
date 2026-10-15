import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/pdf/ss4-fill", () => ({ fillSS4: vi.fn() }))

import { ss4FillDataFromRow, unsignedSs4Names } from "@/lib/operations/ss4-store"

const row = { company_name: "Redstone Atlas LLC", entity_type: "single_member_llc", state_of_formation: "Wyoming", member_count: 1, responsible_party_name: "A B", responsible_party_title: "Member" }

describe("ss4FillDataFromRow", () => {
  it("maps the application row to the form data", () => {
    const d = ss4FillDataFromRow({ ...row, trade_name: "RA", formation_date: "2026-10-15", responsible_party_itin: "900-00-0000", county_and_state: "Laramie, WY" })
    expect(d).toMatchObject({ companyName: "Redstone Atlas LLC", tradeName: "RA", formationDate: "2026-10-15", responsiblePartyItin: "900-00-0000", countyAndState: "Laramie, WY", memberCount: 1 })
  })
  it("empty optional values become undefined / empty, never null", () => {
    const d = ss4FillDataFromRow({ ...row, trade_name: null, formation_date: null, responsible_party_itin: null, responsible_party_phone: null, county_and_state: null })
    expect(d.tradeName).toBeUndefined()
    expect(d.formationDate).toBe("")
    expect(d.responsiblePartyItin).toBeUndefined()
  })
  it("a legacy row with no mailing address gets the fallback address", () => {
    const d = ss4FillDataFromRow({ ...row, mailing_street: null, mailing_city_state_zip: null })
    expect(d.mailingStreet).toBeTruthy()
    expect(d.mailingCityStateZip).toBeTruthy()
  })
  it("a stored mailing address is kept", () => {
    const d = ss4FillDataFromRow({ ...row, mailing_street: "1 Main St", mailing_city_state_zip: "Cheyenne, WY 82001" })
    expect(d.mailingStreet).toBe("1 Main St")
  })
})

describe("unsignedSs4Names", () => {
  it("one stable file name and key per application", () => {
    expect(unsignedSs4Names("Redstone Atlas LLC", "abc")).toEqual({ fileName: "Form SS-4 - Redstone Atlas LLC - Unsigned.pdf", callerKey: "ss4-unsigned:abc" })
  })
})
