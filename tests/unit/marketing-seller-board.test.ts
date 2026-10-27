import { describe, it, expect } from "vitest"
import { leadActionSchema, permissionFor, planLeadAction, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { eventText } from "@/lib/marketing/lead-view"
import { idRangeFor, shortCodeFor, shortPayUrl } from "@/lib/marketing/short-pay"
import { resolveTour } from "@/lib/marketing/tour"
import { stageForPaidSale } from "@/lib/marketing/sales"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"
import { makeT } from "@/lib/marketing/i18n"

const settings: ActionSettings = {
  stages: MARKETING_SETTING_DEFS.pipeline_stages.fallback,
  reasons: [{ key: "other", label: "Other" }], checklist: [],
  outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
  sellerStages: MARKETING_SETTING_DEFS.seller_result_stages.fallback,
}
const NOW = new Date("2026-10-26T10:00:00Z")
const rocco: Actor = { id: "r", email: "rocco@x.com", role: "member" }
const lead = (status: string, extra: Record<string, unknown> = {}) => ({ claimed_by: null, status, ...extra })

describe("the seller's results after the call (Rocco, 2026-10-26)", () => {
  it("are marks (need the 'mark' right) and validate their shape", () => {
    for (const a of ["not_ready", "closed", "not_closed"] as const) expect(permissionFor(a)).toBe("leads.mark")
    expect(leadActionSchema.safeParse({ action: "closed" }).success).toBe(true)
    expect(leadActionSchema.safeParse({ action: "not_closed", note: "price" }).success).toBe(true)
    expect(leadActionSchema.safeParse({ action: "not_ready" }).success).toBe(false) // a day to come back is required
    expect(leadActionSchema.safeParse({ action: "not_ready", callbackAt: "2027-04-20T10:00:00Z" }).success).toBe(true)
  })
  it("Closed and Not closed move the lead to their column and clear any come-back day", () => {
    expect(planLeadAction({ action: "closed", note: "signed" }, lead("showed", { callback_at: "2026-11-01T10:00:00Z" }), rocco, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "closed", callback_at: null }, event: { kind: "status_changed", data: { to: "closed", outcome: "closed", note: "signed" } } } })
    expect(planLeadAction({ action: "not_closed" }, lead("booked"), rocco, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "not_closed" }, event: { data: { outcome: "not_closed" } } } })
  })
  it("Not ready now stores the day to come back, and may be up to a year away (six months was too short)", () => {
    const sixMonths = new Date(NOW.getTime() + 190 * 24 * 3600 * 1000).toISOString()
    expect(planLeadAction({ action: "not_ready", callbackAt: sixMonths }, lead("showed"), rocco, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "not_ready", callback_at: sixMonths }, event: { data: { outcome: "not_ready" } } } })
    const tooFar = new Date(NOW.getTime() + 400 * 24 * 3600 * 1000).toISOString()
    expect(planLeadAction({ action: "not_ready", callbackAt: tooFar }, lead("showed"), rocco, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    // the setter's "call back later" keeps its six months
    expect(planLeadAction({ action: "call_back", callbackAt: sixMonths }, lead("contacted"), rocco, settings, NOW)).toMatchObject({ ok: false, status: 400 })
  })
  it("a team whose stage list has no such stage gets a plain refusal, not a broken lead", () => {
    const old = { ...settings, stages: settings.stages.filter(s => s.key !== "closed") }
    expect(planLeadAction({ action: "closed" }, lead("showed"), rocco, old, NOW)).toMatchObject({ ok: false, status: 400 })
  })
  it("a new booked call brings a lead Rocco put aside back to the booked calls; a Closed lead stays Closed", () => {
    const at = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000).toISOString()
    expect(planLeadAction({ action: "appointment", at }, lead("not_ready", { callback_at: "2027-01-01T10:00:00Z" }), rocco, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "booked", callback_at: null } } })
    expect(planLeadAction({ action: "appointment", at }, lead("not_closed"), rocco, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "booked" } } })
    expect(planLeadAction({ action: "appointment", at }, lead("closed"), rocco, settings, NOW)).toMatchObject({ ok: true, change: { patch: {} } })
  })
  it("the come-back day of a Not ready now lead can be moved from the calendar", () => {
    const at = new Date(NOW.getTime() + 20 * 24 * 3600 * 1000).toISOString()
    const r = planLeadAction({ action: "reschedule", target: "callback", at, reason: "Client asked", from: "2026-12-01T10:00:00Z" }, lead("not_ready", { callback_at: "2026-12-01T10:00:00Z" }), rocco, settings, NOW)
    expect(r).toMatchObject({ ok: true, change: { patch: { callback_at: at } } })
  })
  it("a Closed lead that pays moves to Paid: the paid stage does not depend on where the lead was", () => {
    expect(stageForPaidSale("strategic_call", MARKETING_SETTING_DEFS.sale_kind_stages.fallback, settings.stages)).toBe("paid_call")
  })
  it("the history says what happened in plain words, in both languages", () => {
    const stages = settings.stages
    const en = makeT("en"); const it_ = makeT("it")
    expect(eventText("status_changed", { outcome: "closed", to: "closed" }, stages, [], en, "en-GB")).toBe("Link sent")
    expect(eventText("status_changed", { outcome: "closed", to: "closed" }, stages, [], it_, "it-IT")).toBe("Link inviato")
    expect(eventText("status_changed", { outcome: "not_closed", to: "not_closed" }, stages, [], it_, "it-IT")).toBe("Non chiuso")
    expect(eventText("status_changed", { outcome: "not_ready", to: "not_ready", callback_at: "2027-01-01T10:00:00Z" }, stages, [], it_, "it-IT")).toMatch(/^Non pronto ora — richiamare il /)
  })
})

describe("the short payment address", () => {
  const id = "0b0e6a1c-3d5f-4c3a-9a47-5a1d2f7e8b90"
  it("is the first twelve hex digits of the sale id", () => {
    expect(shortCodeFor(id)).toBe("0b0e6a1c3d5f")
    expect(shortPayUrl("https://app.example.test/", id)).toBe("https://app.example.test/pay/s/0b0e6a1c3d5f")
    expect(shortCodeFor("not-a-uuid")).toBeNull()
    expect(shortPayUrl("https://x.test", "nope")).toBeNull()
  })
  it("finds the sale by the id range that starts with the code, and refuses anything else", () => {
    expect(idRangeFor("0B0E6A1C3D5F")).toEqual({ lo: "0b0e6a1c-3d5f-0000-0000-000000000000", hi: "0b0e6a1c-3d5f-ffff-ffff-ffffffffffff" })
    const r = idRangeFor("0b0e6a1c3d5f")!
    expect(r.lo <= id && id <= r.hi).toBe(true)
    for (const bad of ["", "0b0e6a1c3d5", "0b0e6a1c3d5fa", "zzzzzzzzzzzz", "0b0e6a1c-3d5f", "../../etc"]) expect(idRangeFor(bad)).toBeNull()
  })
})

describe("the seller's tour explains every column", () => {
  const perms = ["leads.read", "payment_links.create", "calls.host", "leads.pick", "leads.mark", "chat", "calendar.read", "reports.read", "templates.use"]
  it("names every column and result of Rocco's path in English and in Italian (27 Oct 2026)", () => {
    const en = resolveTour("seller", perms, "en").find(s => s.screen === "board")
    const it_ = resolveTour("seller", perms, "it").find(s => s.screen === "board")
    for (const w of ["Interested lead", "Contacted", "Link sent", "Not in target", "Not ready now", "Paid", "Booking link sent", "Upsell", "Waiting", "Archive", "Incoming messages"]) expect(en?.body, w).toContain(w)
    for (const w of ["Lead interessato", "Contattato", "Link inviato", "Fuori target", "Non pronto ora", "Pagato", "Link prenotazione inviato", "Upsell", "In attesa", "Archivia", "Messaggi in arrivo"]) expect(it_?.body, w).toContain(w)
  })
})

describe("bug hunt on PR 854 (fixes)", () => {
  const rocco: Actor = { id: "r", email: "rocco@x.com", role: "member" }
  const NOW = new Date("2026-10-26T10:00:00Z")
  const lead = (status: string, extra: Record<string, unknown> = {}) => ({ claimed_by: null, status, ...extra })
  const withPaid: ActionSettings = { ...settings, paidStages: ["paid_call", "upsell_won"] }
  it("a lead that has already paid cannot be pulled out of Paid by Closed, Not closed or Not ready now", () => {
    const day = new Date(NOW.getTime() + 20 * 24 * 3600 * 1000).toISOString()
    for (const a of [{ action: "closed" }, { action: "not_closed" }, { action: "not_ready", callbackAt: day }] as const) {
      expect(planLeadAction(a, lead("paid_call"), rocco, withPaid, NOW)).toMatchObject({ ok: false, status: 409 })
      expect(planLeadAction(a, lead("upsell_won"), rocco, withPaid, NOW)).toMatchObject({ ok: false, status: 409 })
    }
  })
  it("pressing the result a lead already has changes nothing (no duplicate history); a new day for Not ready now is allowed", () => {
    expect(planLeadAction({ action: "closed" }, lead("closed"), rocco, settings, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction({ action: "not_closed" }, lead("not_closed"), rocco, settings, NOW)).toMatchObject({ ok: false, status: 409 })
    const day = new Date(NOW.getTime() + 20 * 24 * 3600 * 1000).toISOString()
    expect(planLeadAction({ action: "not_ready", callbackAt: day }, lead("not_ready"), rocco, settings, NOW)).toMatchObject({ ok: true })
  })
  it("a Not ready now day that was allowed up to a year can be moved up to a year, a setter call back only six months", () => {
    const far = new Date(NOW.getTime() + 300 * 24 * 3600 * 1000).toISOString()
    expect(planLeadAction({ action: "reschedule", target: "callback", at: far, reason: "Client asked" }, lead("not_ready", { callback_at: "2026-12-01T10:00:00Z" }), rocco, settings, NOW)).toMatchObject({ ok: true })
    expect(planLeadAction({ action: "reschedule", target: "callback", at: far, reason: "Client asked" }, lead("contacted", { callback_at: "2026-12-01T10:00:00Z" }), rocco, settings, NOW)).toMatchObject({ ok: false, status: 400 })
  })
  it("the setter's call list leaves out a lead Rocco put aside, and the calendar gives its day to whoever pressed Not ready now", async () => {
    const { callQueue } = await import("@/lib/marketing/workspace")
    const { latestSetters } = await import("@/lib/marketing/calendar")
    const base = { id: "a", team_id: "t", status: "not_ready", claimed_by: null, callback_at: "2026-10-20T10:00:00Z", meta_created_time: null, received_at: "2026-10-01T10:00:00Z", phone: null, full_name: "x", email: null, ad_name: null, answers: [], city: null, country: null, campaign_name: null, adset_name: null, claimed_at: null, claimed_by_label: null } as never
    expect(callQueue([base], "new", "me", NOW, ["not_ready"])).toHaveLength(0)
    expect(callQueue([base], "new", "me", NOW)).toHaveLength(1)
    expect(latestSetters([{ lead_id: "a", actor: "rocco@x.com", created_at: "2026-10-26T10:00:00Z", data: { outcome: "not_ready" } }]).get("a")?.actor).toBe("rocco@x.com")
  })
  it("a lead the setter turned down before it reached Rocco is not on his Not in target column; one he saw (passed on or with a call) is", async () => {
    const { columnOfCard } = await import("@/lib/marketing/board")
    expect(columnOfCard("seller", { stage: "not_in_target", handedOver: false, apptAt: null })).toBeNull()
    expect(columnOfCard("seller", { stage: "not_in_target", handedOver: true, apptAt: null })).toBe("out")
    expect(columnOfCard("seller", { stage: "not_in_target", handedOver: false, apptAt: "2026-10-27T10:00:00Z" })).toBe("out")
  })
})
