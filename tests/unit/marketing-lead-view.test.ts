import { describe, it, expect } from "vitest"
import { clientFlagText, formatWhen, prettyQuestion, stageLabel, telHref } from "@/lib/marketing/lead-view"
import { getTeamLead, listTeamLeads } from "@/lib/marketing/leads-read"
import { FakeDb } from "./helpers/fake-lead-db"

describe("lead view helpers", () => {
  it("stage labels fall back to the key, never blank", () => {
    const stages = [{ key: "new", label: "New" }]
    expect(stageLabel(stages, "new")).toBe("New")
    expect(stageLabel(stages, "custom_stage")).toBe("custom_stage")
    expect(stageLabel(stages, null)).toBe("—")
  })
  it("question keys read as text", () => {
    expect(prettyQuestion("hai_una_attività")).toBe("Hai una attività")
    expect(prettyQuestion("  __ ")).toBe("  __ ")
  })
  it("times are shown in one fixed zone", () => {
    expect(formatWhen("2026-10-19T08:15:00Z")).toContain("10:15")
    expect(formatWhen(null)).toBe("—")
    expect(formatWhen("garbage")).toBe("—")
  })
  it("client flags say what to do, and a failed check is never silent", () => {
    expect(clientFlagText(null)).toBeNull()
    expect(clientFlagText({ contact_ids: [], matched_on: [] })).toBeNull()
    expect(clientFlagText({ contact_ids: ["c1"], matched_on: ["email", "phone"] })).toMatch(/existing TD client.*email and phone number/)
    expect(clientFlagText({ check_failed: true, contact_ids: [] })).toMatch(/could not check/)
  })
  it("tel links need a real number", () => {
    expect(telHref("+39 333 111 2233")).toBe("tel:+393331112233")
    expect(telHref("12")).toBeNull()
    expect(telHref(null)).toBeNull()
  })
})

describe("team-scoped lead reads", () => {
  const seed = () => {
    const db = new FakeDb()
    db.rows("marketing_leads").push({ id: "11111111-1111-1111-1111-111111111111", team_id: "A", received_at: "2026-10-19T10:00:00Z" })
    db.rows("marketing_leads").push({ id: "22222222-2222-2222-2222-222222222222", team_id: "B", received_at: "2026-10-19T11:00:00Z" })
    return db
  }
  it("lists only the caller's team", async () => {
    expect((await listTeamLeads(seed(), "A")).map(l => l.id)).toEqual(["11111111-1111-1111-1111-111111111111"])
  })
  it("guessing another team's lead id returns nothing", async () => {
    expect(await getTeamLead(seed(), "A", "22222222-2222-2222-2222-222222222222")).toBeNull()
    expect((await getTeamLead(seed(), "A", "11111111-1111-1111-1111-111111111111"))?.team_id).toBe("A")
  })
  it("a malformed id never reaches the database", async () => {
    expect(await getTeamLead(seed(), "A", "1' or 1=1 --")).toBeNull()
  })
})
