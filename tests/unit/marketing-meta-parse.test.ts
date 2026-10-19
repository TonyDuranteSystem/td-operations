import { describe, it, expect } from "vitest"
import { parseLeadgenWebhook } from "@/lib/marketing/meta-leads/parse-webhook"
import { mapGraphLead, normalizeEmail, normalizePhone } from "@/lib/marketing/meta-leads/map-lead"

const body = (changes: unknown[], pageId: unknown = "111") => ({ object: "page", entry: [{ id: pageId, time: 1760000000, changes }] })
const lg = (v: Record<string, unknown>) => ({ field: "leadgen", value: v })

describe("parseLeadgenWebhook", () => {
  it("reads a leadgen change (ids only)", () => {
    const r = parseLeadgenWebhook(body([lg({ leadgen_id: "9001", page_id: "111", form_id: "222", ad_id: "333", adgroup_id: "444", created_time: 1760000000 })]))
    expect(r).toEqual([{ leadgenId: "9001", pageId: "111", formId: "222", adId: "333", adgroupId: "444", createdTime: new Date(1760000000 * 1000).toISOString() }])
  })
  it("falls back to the entry's page id", () => {
    expect(parseLeadgenWebhook(body([lg({ leadgen_id: 9002 })]))[0]).toMatchObject({ leadgenId: "9002", pageId: "111" })
  })
  it("ignores other fields, malformed items and non-numeric ids", () => {
    const r = parseLeadgenWebhook(body([{ field: "feed", value: { leadgen_id: "1" } }, lg({ leadgen_id: "abc" }), lg({}), null, lg({ leadgen_id: "9003" })]))
    expect(r.map(e => e.leadgenId)).toEqual(["9003"])
  })
  it("collapses a repeated leadgen id inside one body", () => {
    expect(parseLeadgenWebhook(body([lg({ leadgen_id: "9004" }), lg({ leadgen_id: "9004" })]))).toHaveLength(1)
  })
  it("never throws on garbage", () => {
    for (const g of [null, undefined, 5, "x", [], {}, { entry: "no" }, { entry: [null, 3, { changes: "no" }] }]) expect(parseLeadgenWebhook(g)).toEqual([])
  })
})

describe("normalizers", () => {
  it("emails", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com")
    expect(normalizeEmail("nope")).toBeNull()
    expect(normalizeEmail(5)).toBeNull()
  })
  it("phones keep a leading plus and need 6+ digits", () => {
    expect(normalizePhone("+39 342 703-8798")).toBe("+393427038798")
    expect(normalizePhone("0039 342 7038798")).toBe("+393427038798")
    expect(normalizePhone("342 7038798")).toBe("3427038798")
    expect(normalizePhone("12")).toBeNull()
    expect(normalizePhone(null)).toBeNull()
  })
})

describe("mapGraphLead", () => {
  const graph = {
    id: "9001", created_time: "2026-10-19T10:00:00+0000", ad_id: "333", ad_name: "Ad A", adset_id: "444", adset_name: "Set", campaign_id: "555",
    campaign_name: "14.10.2026 | LLC ITA | Lead Form", form_id: "222", is_organic: false, platform: "fb",
    field_data: [
      { name: "full_name", values: ["Mario  Rossi"] },
      { name: "email", values: ["MARIO@Example.com"] },
      { name: "phone_number", values: ["+39 333 1112233"] },
      { name: "city", values: ["Torino"] },
      { name: "hai_una_attività", values: ["sì", "in Italia"] },
    ],
  }
  it("extracts the convenience columns and keeps EVERY answer as received", () => {
    const m = mapGraphLead(graph)
    expect(m).toMatchObject({ leadgenId: "9001", fullName: "Mario Rossi", email: "mario@example.com", phone: "+393331112233", city: "Torino", campaignName: "14.10.2026 | LLC ITA | Lead Form", formId: "222", platform: "fb", isOrganic: false })
    expect(m.answers).toHaveLength(5)
    expect(m.answers[4]).toEqual({ name: "hai_una_attività", values: ["sì", "in Italia"] })
    expect(m.metaCreatedTime).toBe("2026-10-19T10:00:00.000Z")
  })
  it("builds the name from first + last when there is no full name", () => {
    expect(mapGraphLead({ id: "1", field_data: [{ name: "first_name", values: ["Ana"] }, { name: "last_name", values: ["Bianchi"] }] }).fullName).toBe("Ana Bianchi")
  })
  it("survives a lead with no field data or odd shapes", () => {
    const m = mapGraphLead({ id: "2" })
    expect(m).toMatchObject({ fullName: null, email: null, phone: null, answers: [] })
    expect(mapGraphLead({ id: "3", field_data: [{ name: "email" }, { values: ["x"] }, { name: "country", values: [null, 5] }] as never }).answers).toEqual([{ name: "email", values: [] }, { name: "country", values: ["5"] }])
  })
})

import { parseSettingValue, defaultForSetting } from "@/lib/marketing/settings-schema"
describe("lead_intake_team_id setting", () => {
  it("defaults to no team chosen, accepts a team id or an empty value (so it can be cleared), refuses anything else", () => {
    expect(defaultForSetting("lead_intake_team_id")).toBe("")
    expect(parseSettingValue("lead_intake_team_id", "")).toEqual({ ok: true, value: "" })
    expect(parseSettingValue("lead_intake_team_id", "bc54d2f9-f62c-48de-b995-3a404123f8b8").ok).toBe(true)
    expect(parseSettingValue("lead_intake_team_id", "not-a-uuid").ok).toBe(false)
    expect(parseSettingValue("lead_intake_team_id", null).ok).toBe(false)
    expect(parseSettingValue("lead_intake_team_id", 5).ok).toBe(false)
  })
})
