import { describe, expect, it } from "vitest"
import { messageSigner, whatsappLink, whatsappWebLink } from "@/lib/marketing/templates"
import { whatsappDay, WA_WINDOW_NAME } from "@/lib/marketing/whatsapp-web"
import { leadActionSchema, planLeadAction, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { contactState } from "@/lib/marketing/contact-state"
import { eventText } from "@/lib/marketing/lead-view"

describe("whatsappWebLink", () => {
  it("opens WhatsApp Web straight on the chat with the text written", () => {
    expect(whatsappWebLink("+39 333 123 4567", "Ciao Giulia & benvenuta")).toBe("https://web.whatsapp.com/send?phone=393331234567&text=Ciao%20Giulia%20%26%20benvenuta")
  })
  it("understands 00 prefixes and refuses numbers that are not usable", () => {
    expect(whatsappWebLink("0039 333 123 4567", "x")).toContain("phone=393331234567")
    expect(whatsappWebLink("12345", "x")).toBeNull()
    expect(whatsappWebLink(null, "x")).toBeNull()
    expect(whatsappWebLink("1".repeat(16), "x")).toBeNull()
  })
  it("never builds a chat address from a number that could be a stranger's", () => {
    for (const bad of ["+39 333 123 4567 int. 12", "+39 333 123 4567 ext 5", "(305) 555-0100", "333 1234567", "+39 333 1234567 / 06 123456", "tel 3331234567"]) expect(whatsappWebLink(bad, "x")).toBeNull()
  })
  it("drops the trunk zero in brackets and accepts a full international number written any way", () => {
    expect(whatsappWebLink("+39 (0)333 1234567", "x")).toContain("phone=393331234567")
    expect(whatsappWebLink("+1 (305) 555-0100", "x")).toContain("phone=13055550100")
    expect(whatsappWebLink("393331234567", "x")).toContain("phone=393331234567")
  })
  it("the old wa.me link still works the same", () => {
    expect(whatsappLink("+39 333 123 4567", "a b")).toBe("https://wa.me/393331234567?text=a%20b")
  })
  it("the window has a fixed name, so every link reuses the same window", () => {
    expect(WA_WINDOW_NAME).toBe("tdm-whatsapp")
  })
})

describe("whatsappDay (one person, Rome day)", () => {
  const now = new Date("2026-10-26T10:00:00Z")
  const ev = (lead: string, state: string, at: string, actor = "cristina@x.com", extra: object = {}) => ({ lead_id: lead, kind: "whatsapp", actor, created_at: at, data: { state, ...extra } })
  it("counts leads opened today, and of those how many were confirmed sent", () => {
    const events = [ev("a", "opened", "2026-10-26T08:00:00Z"), ev("a", "sent", "2026-10-26T08:01:00Z"), ev("b", "opened", "2026-10-26T08:30:00Z"), ev("c", "opened", "2026-10-26T09:00:00Z"), ev("c", "opened", "2026-10-26T09:05:00Z")]
    expect(whatsappDay(events, "cristina@x.com", now)).toEqual({ opened: 3, sent: 1 })
  })
  it("ignores other people, other days, View as rows and other kinds", () => {
    const events = [ev("a", "opened", "2026-10-26T08:00:00Z", "rocco@x.com"), ev("b", "opened", "2026-10-24T08:00:00Z"), ev("c", "opened", "2026-10-26T08:00:00Z", "cristina@x.com", { via_view_as: true }), { lead_id: "d", kind: "note", actor: "cristina@x.com", created_at: "2026-10-26T08:00:00Z", data: {} }]
    expect(whatsappDay(events, "cristina@x.com", now)).toEqual({ opened: 0, sent: 0 })
  })
  it("a sent note counts even when the lead was opened another day or sent with the old button", () => {
    expect(whatsappDay([ev("a", "sent", "2026-10-26T08:00:00Z")], "cristina@x.com", now)).toEqual({ opened: 0, sent: 1 })
  })
})

describe("the whatsapp action with state 'opened'", () => {
  const settings: ActionSettings = {
    stages: [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }],
    reasons: [], checklist: [], outcomeStages: { good: "contacted", not_in_target: "contacted", call_back: "contacted" },
  }
  const actor: Actor = { id: "u", email: "cristina@x.com", role: "member" }
  const NOW = new Date("2026-10-26T10:00:00Z")
  it("is accepted, writes an 'opened' note and does NOT move the lead", () => {
    expect(leadActionSchema.safeParse({ action: "whatsapp", state: "opened", template: "first_contact" }).success).toBe(true)
    expect(planLeadAction({ action: "whatsapp", state: "opened", template: "first_contact" }, { claimed_by: null, status: "new" }, actor, settings, NOW))
      .toMatchObject({ ok: true, change: { patch: {}, event: { kind: "whatsapp", data: { state: "opened", template: "first_contact" } } } })
  })
  it("an 'opened' note does not make the person the lead's signer", () => {
    const nameOf = (a: string) => a
    expect(messageSigner({ claimedLabel: null, events: [{ kind: "whatsapp", actor: "a@x.com", created_at: "2026-10-26T08:00:00Z", data: { state: "opened" } }], viewerName: "Bea", viewingAs: false, nameOf })).toBe("Bea")
    expect(messageSigner({ claimedLabel: null, events: [{ kind: "whatsapp", actor: "a@x.com", created_at: "2026-10-26T08:00:00Z", data: { state: "sent" } }], viewerName: "Bea", viewingAs: false, nameOf })).toBe("a@x.com")
  })
  it("'sent' still moves a new lead to contacted", () => {
    expect(planLeadAction({ action: "whatsapp", state: "sent" }, { claimed_by: null, status: "new" }, actor, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "contacted" } } })
  })
  it("the history reads 'WhatsApp Web opened' and the contact state ignores it", () => {
    expect(eventText("whatsapp", { state: "opened" }, [], [])).toContain("WhatsApp Web opened")
    expect(contactState([{ kind: "whatsapp", created_at: "2026-10-26T10:00:00Z", data: { state: "opened" } }]).contacted).toBe(false)
  })
})
