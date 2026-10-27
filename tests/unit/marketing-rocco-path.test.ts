import { describe, it, expect } from "vitest"
import { planLeadAction, leadActionSchema, hasPaidOrLater, onSellerSide, permissionFor, sellerOf, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { columnOfCard, columnsFor, type BoardCard } from "@/lib/marketing/board"
import { isSetterOnly, visibleToSetter, pushRecipients } from "@/lib/marketing/lead-chat"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"
import { eventText } from "@/lib/marketing/lead-view"

// The call of 27 Oct 2026 (Rocco and Antonio): Interested lead -> Contacted -> Link sent -> Paid -> Booking link sent -> Upsell / Waiting -> Archived; Not in target and Not ready now are the ways out.
const stages = MARKETING_SETTING_DEFS.pipeline_stages.fallback
const settings: ActionSettings = {
  stages,
  reasons: [{ key: "other", label: "Other" }],
  checklist: [],
  outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
  paidStages: ["paid_call", "upsell_won"],
  sellerStages: MARKETING_SETTING_DEFS.seller_result_stages.fallback,
}
const NOW = new Date("2026-10-27T10:00:00Z")
const rocco: Actor = { id: "u-rocco", email: "rocco@x.com", role: "owner" }
const at = (status: string) => ({ claimed_by: null, status })
const plan = (input: Parameters<typeof planLeadAction>[0], status: string) => planLeadAction(input, at(status), rocco, settings, NOW)

describe("Rocco's path: the stages exist and are in the order of the path", () => {
  it("every new stage is a real pipeline stage, after Showed and in the path's order", () => {
    const keys = stages.map(s => s.key)
    for (const k of ["seller_contacted", "booking_link", "upsell", "waiting", "archived"]) expect(keys).toContain(k)
    expect(keys.indexOf("seller_contacted")).toBeGreaterThan(keys.indexOf("showed"))
    expect(keys.indexOf("paid_call")).toBeLessThan(keys.indexOf("booking_link"))
    expect(keys.indexOf("booking_link")).toBeLessThan(keys.indexOf("upsell"))
  })
  it("a team that stored only the first three result stages still gets the new keys", () => {
    const s = sellerOf({ sellerStages: { not_ready: "nr", closed: "c", not_closed: "nc" } })
    expect(s).toMatchObject({ not_ready: "nr", contacted: "seller_contacted", booking_link: "booking_link", upsell: "upsell", waiting: "waiting", archived: "archived" })
  })
  it("paid, or past paying, is one idea: Paid, Booking link sent, Upsell, Waiting (and the paid stages of the sale kinds); Archived is not: a lead archived without paying can be worked again", () => {
    for (const k of ["paid_call", "upsell_won", "booking_link", "upsell", "waiting"]) expect(hasPaidOrLater(k, settings)).toBe(true)
    for (const k of ["new", "qualified", "booked", "seller_contacted", "closed", "not_ready", "not_in_target", "archived"]) expect(hasPaidOrLater(k, settings)).toBe(false)
  })
  it("Rocco's side of the road is every stage from Contacted on, archived included; the setter's own stages are not", () => {
    for (const k of ["seller_contacted", "closed", "not_ready", "not_closed", "paid_call", "booking_link", "upsell", "waiting", "archived"]) expect(onSellerSide(k, settings), k).toBe(true)
    for (const k of ["new", "contacted", "qualified", "booked", "showed", "not_in_target"]) expect(onSellerSide(k, settings), k).toBe(false)
  })
  it("the seller's buttons need the seller's right (leads.pick), the setter's keep leads.mark", () => {
    for (const a of ["contacted", "booking_link", "upsell", "waiting", "archive", "not_ready", "closed", "not_closed"] as const) expect(permissionFor(a), a).toBe("leads.pick")
    for (const a of ["good", "call_back", "not_in_target", "note", "whatsapp", "appointment", "handover"] as const) expect(permissionFor(a), a).toBe("leads.mark")
  })
})

describe("Contacted", () => {
  it("moves an interested lead to Contacted and writes it in the history", () => {
    const p = plan({ action: "contacted", note: "spoke on the phone" }, "booked")
    expect(p.ok && p.change.patch).toMatchObject({ status: "seller_contacted" })
    expect(p.ok && p.change.event).toMatchObject({ kind: "status_changed", data: { from: "booked", to: "seller_contacted", outcome: "contacted", note: "spoke on the phone" } })
  })
  it("refuses twice in a row, a lead already paid and a lead marked Not in target", () => {
    expect(plan({ action: "contacted" }, "seller_contacted")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "contacted" }, "paid_call")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "contacted" }, "booking_link")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "contacted" }, "not_in_target")).toMatchObject({ ok: false, status: 409 })
  })
  it("a lead archived without paying can be worked again (it is not a dead end)", () => {
    expect(plan({ action: "contacted" }, "archived")).toMatchObject({ ok: true, change: { patch: { status: "seller_contacted" } } })
  })
  it("a lead that was Not ready now can be contacted again", () => {
    expect(plan({ action: "contacted" }, "not_ready")).toMatchObject({ ok: true, change: { patch: { status: "seller_contacted", callback_at: null } } })
  })
})

describe("the booking link", () => {
  const url = "https://calendly.com/rocco/consultation"
  it("only after the lead has paid", () => {
    expect(plan({ action: "booking_link", url, via: "whatsapp" }, "closed")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "booking_link", url, via: "whatsapp" }, "booked")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "booking_link", url, via: "email" }, "archived")).toMatchObject({ ok: false, status: 409 }) // archived without paying: no booking link either
  })
  it("a lead that has just paid moves to Booking link sent; the link and how it was sent are in the history", () => {
    const p = plan({ action: "booking_link", url, via: "email" }, "paid_call")
    expect(p.ok && p.change.patch).toMatchObject({ status: "booking_link" })
    expect(p.ok && p.change.event).toMatchObject({ kind: "booking_link", data: { url, via: "email", from: "paid_call", to: "booking_link" } })
  })
  it("a lead further along (upsell, waiting) stays where it is; the link is only written in the history", () => {
    const p = plan({ action: "booking_link", url, via: "whatsapp" }, "upsell")
    expect(p.ok && p.change.patch).toEqual({})
    expect(p.ok && p.change.event).toMatchObject({ kind: "booking_link", data: { to: "upsell" } })
  })
  it("the link must be a real https address", () => {
    for (const bad of ["calendly.com/x", "http://calendly.com/x", "javascript:alert(1)", "https://", "https://nodot", "https://a b.com/x", "https://calendly.com/x y", "https://calendly.com/x\nhttps://evil.example"]) {
      expect(leadActionSchema.safeParse({ action: "booking_link", url: bad }).success, bad).toBe(false)
    }
    expect(leadActionSchema.safeParse({ action: "booking_link", url }).success).toBe(true)
  })
})

describe("Upsell, Waiting, Archive", () => {
  it("Upsell and Waiting only for a lead that has paid", () => {
    expect(plan({ action: "upsell" }, "closed")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "waiting" }, "booked")).toMatchObject({ ok: false, status: 409 })
    expect(plan({ action: "upsell" }, "booking_link")).toMatchObject({ ok: true, change: { patch: { status: "upsell" } } })
    expect(plan({ action: "waiting" }, "booking_link")).toMatchObject({ ok: true, change: { patch: { status: "waiting" } } })
  })
  it("Archive closes the pipeline from anywhere, once", () => {
    expect(plan({ action: "archive" }, "waiting")).toMatchObject({ ok: true, change: { patch: { status: "archived" }, event: { data: { outcome: "archive" } } } })
    expect(plan({ action: "archive" }, "not_in_target")).toMatchObject({ ok: true })
    expect(plan({ action: "archive" }, "archived")).toMatchObject({ ok: false, status: 409 })
  })
  it("a stage that is not set up is refused in plain words", () => {
    const bare = { ...settings, stages: stages.filter(s => s.key !== "upsell") }
    expect(planLeadAction({ action: "upsell" }, at("booking_link"), rocco, bare, NOW)).toMatchObject({ ok: false, status: 400 })
  })
  it("a setter's Good and Call back later never pull back a lead that has moved on to Rocco", () => {
    for (const status of ["seller_contacted", "closed", "paid_call", "booking_link", "upsell", "waiting", "archived"]) {
      expect(plan({ action: "good", ticked: [] }, status), status).toMatchObject({ ok: false, status: 409 })
      expect(plan({ action: "call_back", callbackAt: "2026-10-28T10:00:00Z" }, status), status).toMatchObject({ ok: false, status: 409 })
    }
    expect(plan({ action: "good", ticked: [] }, "contacted")).toMatchObject({ ok: true })
    expect(plan({ action: "call_back", callbackAt: "2026-10-28T10:00:00Z" }, "booked")).toMatchObject({ ok: true })
  })
  it("after the consultation Not in target is still possible", () => {
    expect(plan({ action: "not_in_target", reason: "other" }, "booking_link")).toMatchObject({ ok: true, change: { patch: { status: "not_in_target" } } })
  })
})

describe("the board: Incoming messages and the setter's columns", () => {
  const card = (stage: string, o: Partial<BoardCard> = {}): Pick<BoardCard, "stage" | "handedOver"> & { unread?: number } => ({ stage, handedOver: true, ...o })
  it("a lead of Rocco's board with an unread message sits in Incoming messages; nothing unread, its own column", () => {
    expect(columnOfCard("seller", card("booked", { unread: 2 }))).toBe("incoming")
    expect(columnOfCard("seller", card("closed", { unread: 1 }))).toBe("incoming")
    expect(columnOfCard("seller", card("closed", { unread: 0 }))).toBe("closed")
    expect(columnOfCard("seller", card("paid_call"))).toBe("paid")
  })
  it("a lead that is not on his board stays off it, unread or not", () => {
    expect(columnOfCard("seller", card("qualified", { handedOver: false, unread: 3 }))).toBeNull()
    expect(columnOfCard("seller", card("new", { unread: 3 }))).toBeNull()
  })
  it("the setter's board has no Incoming column and no Paid; her last column is Interested lead", () => {
    expect(columnsFor("setter").map(c => c.key)).not.toContain("incoming")
    expect(columnsFor("setter").map(c => c.key)).not.toContain("paid")
    expect(columnsFor("setter").find(c => c.key === "booked")?.label).toBe("Interested lead")
    expect(columnOfCard("setter", card("booked", { unread: 4 }))).toBe("booked")
  })
})

describe("the setter: no inbox, and only her own side of a lead's chat", () => {
  const bundles = MARKETING_SETTING_DEFS.permission_bundles.fallback
  it("the setter bundle has no inbox (she has no email address); the seller keeps it", () => {
    expect(bundles.setter).not.toContain("inbox")
    expect(bundles.seller).toContain("inbox")
  })
  it("a setter is recognised from her permissions; the seller and the owner are not setters", () => {
    expect(isSetterOnly(bundles.setter)).toBe(true)
    expect(isSetterOnly(bundles.seller)).toBe(false)
    expect(isSetterOnly([...bundles.setter, "leads.pick"])).toBe(false)
    expect(isSetterOnly(["leads.worklist", "payment_links.create"])).toBe(false)
    expect(isSetterOnly(bundles.content)).toBe(false)
  })
  it("she sees what she and other setters wrote and what names her, and nothing else (Antonio and Rocco's talk stays theirs)", () => {
    const setters = new Set(["s1", "s2"])
    expect(visibleToSetter({ sender_id: "s1" }, "s1", setters)).toBe(true)
    expect(visibleToSetter({ sender_id: "s2" }, "s1", setters)).toBe(true)
    expect(visibleToSetter({ sender_id: "antonio", mentions: null }, "s1", setters)).toBe(false)
    expect(visibleToSetter({ sender_id: "rocco", mentions: [] }, "s1", setters)).toBe(false)
    expect(visibleToSetter({ sender_id: "rocco", mentions: ["s1"] }, "s1", setters)).toBe(true)
    expect(visibleToSetter({ sender_id: "rocco", mentions: ["s2"] }, "s1", setters)).toBe(false)
  })
  it("a setter is notified only when a message names her", () => {
    const members = [
      { user_id: "antonio", status: "active", permissions: ["chat", "leads.read", "leads.mark", "leads.pick", "leads.worklist", "calls.host", "payment_links.create"] },
      { user_id: "rocco", status: "active", permissions: bundles.seller },
      { user_id: "s1", status: "active", permissions: bundles.setter },
    ]
    expect(pushRecipients(members, "antonio")).toEqual(["rocco"])
    expect(pushRecipients(members, "antonio", ["s1"])).toEqual(["rocco", "s1"])
    expect(pushRecipients(members, "s1")).toEqual(["antonio", "rocco"])
  })
})

describe("the history lines", () => {
  it("say what happened in plain words", () => {
    expect(eventText("booking_link", { url: "https://calendly.com/x", via: "email" }, stages, [])).toBe("Booking link sent by email: https://calendly.com/x")
    expect(eventText("status_changed", { to: "seller_contacted", outcome: "contacted" }, stages, [])).toBe("Contacted")
    expect(eventText("status_changed", { to: "upsell", outcome: "upsell" }, stages, [])).toBe("Upsell")
    expect(eventText("status_changed", { to: "waiting", outcome: "waiting" }, stages, [])).toBe("Waiting")
    expect(eventText("status_changed", { to: "archived", outcome: "archive" }, stages, [])).toBe("Archived")
  })
})
