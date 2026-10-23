import { describe, it, expect } from "vitest"
import { contactChips, contactState, contactStates, type ContactEvent } from "@/lib/marketing/contact-state"
import { DEFAULT_TEMPLATES, fillTemplate, firstName, templatesFor, whatsappLink } from "@/lib/marketing/templates"
import { planLeadAction, leadActionSchema, permissionFor, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { eventText } from "@/lib/marketing/lead-view"

const ev = (kind: string, at: string, data: Record<string, unknown> = {}): ContactEvent => ({ kind, created_at: at, data })

describe("contactState", () => {
  it("nothing happened = not contacted", () => {
    expect(contactState([ev("received", "2026-10-20T10:00:00Z")])).toMatchObject({ whatsapp: null, attempts: 0, appointmentAt: null, contacted: false })
  })
  it("WhatsApp sent / no WhatsApp: the newest mark wins; only 'sent' counts as contacted", () => {
    expect(contactState([ev("whatsapp", "2026-10-20T10:00:00Z", { state: "no_wa" })])).toMatchObject({ whatsapp: "no_wa", contacted: false })
    expect(contactState([ev("whatsapp", "2026-10-20T10:00:00Z", { state: "no_wa" }), ev("whatsapp", "2026-10-21T10:00:00Z", { state: "sent" })])).toMatchObject({ whatsapp: "sent", contacted: true })
  })
  it("each no answer counts once; an outcome (the person was reached) resets the count; history order does not matter", () => {
    const rows = [ev("attempt", "2026-10-21T09:00:00Z", { result: "no_answer" }), ev("attempt", "2026-10-20T09:00:00Z", { result: "no_answer" }), ev("attempt", "2026-10-22T09:00:00Z", { result: "no_answer" })]
    expect(contactState(rows)).toMatchObject({ attempts: 3, lastAttemptAt: "2026-10-22T09:00:00Z", contacted: true })
    expect(contactState([...rows, ev("status_changed", "2026-10-23T09:00:00Z", { outcome: "call_back" })]).attempts).toBe(0)
  })
  it("the booked call: the newest wins, null cancels, a bad date is ignored", () => {
    const a = ev("appointment", "2026-10-20T10:00:00Z", { at: "2026-10-26T09:00:00.000Z" })
    expect(contactState([a]).appointmentAt).toBe("2026-10-26T09:00:00.000Z")
    expect(contactState([a, ev("appointment", "2026-10-21T10:00:00Z", { at: null })]).appointmentAt).toBeNull()
    expect(contactState([ev("appointment", "2026-10-21T10:00:00Z", { at: "nonsense" })]).appointmentAt).toBeNull()
  })
  it("Antonio looking in with View as is not the team's work", () => {
    expect(contactState([ev("whatsapp", "2026-10-20T10:00:00Z", { state: "sent", via_view_as: true })]).whatsapp).toBeNull()
  })
  it("many leads from one flat list", () => {
    const m = contactStates([{ lead_id: "a", ...ev("whatsapp", "2026-10-20T10:00:00Z", { state: "sent" }) }, { lead_id: "b", ...ev("attempt", "2026-10-20T10:00:00Z", { result: "no_answer" }) }])
    expect(m.get("a")?.whatsapp).toBe("sent")
    expect(m.get("b")?.attempts).toBe(1)
  })
  it("chips", () => {
    const s = contactState([ev("whatsapp", "2026-10-20T10:00:00Z", { state: "sent" }), ev("attempt", "2026-10-21T10:00:00Z", { result: "no_answer" }), ev("appointment", "2026-10-21T11:00:00Z", { at: "2026-10-26T09:00:00.000Z" })])
    expect(contactChips(s, () => "26 Oct 11:00").map(c => c.text)).toEqual(["WhatsApp ✓", "No answer ×1", "Call 26 Oct 11:00"])
    expect(contactChips(contactState([]), () => "")).toEqual([])
  })
})

describe("templates", () => {
  it("every default has text and a label in both languages, and uses only known placeholders", () => {
    for (const t of DEFAULT_TEMPLATES) for (const l of ["it", "en"] as const) {
      expect(t.text[l].length, `${t.key} ${l}`).toBeGreaterThan(20)
      expect(t.label[l].length).toBeGreaterThan(2)
      expect((t.text[l].match(/\{[a-z_]+\}/g) ?? []).every(p => ["{name}", "{setter}", "{when}"].includes(p)), `${t.key} ${l}`).toBe(true)
    }
  })
  it("the team's own text wins by key; a team-only key is added", () => {
    const t = templatesFor("it", { first_contact: "Ciao {name}", custom_one: "Testo" })
    expect(t.find(x => x.key === "first_contact")?.text).toBe("Ciao {name}")
    expect(t.find(x => x.key === "custom_one")).toMatchObject({ label: "custom_one", text: "Testo" })
    expect(templatesFor("en").find(x => x.key === "first_contact")?.label).toBe("First contact")
  })
  it("fills the name, the setter and the time; an empty name keeps the greeting natural", () => {
    expect(fillTemplate("Buongiorno {name}, sono {setter}.", { name: "Mario", setter: "Cristina" })).toBe("Buongiorno Mario, sono Cristina.")
    expect(fillTemplate("Buongiorno {name}, sono {setter}.", { name: "", setter: "Cristina" })).toBe("Buongiorno, sono Cristina.")
    expect(fillTemplate("Call {when}", { when: "26 Oct 11:00" })).toBe("Call 26 Oct 11:00")
  })
  it("first name", () => {
    expect(firstName("Mario Rossi")).toBe("Mario")
    expect(firstName("  ")).toBe("")
    expect(firstName(null)).toBe("")
  })
  it("whatsapp link: digits only, 00 prefix handled, unusable numbers give nothing, the text is encoded", () => {
    expect(whatsappLink("+39 333 111 2233", "Ciao & grazie")).toBe("https://wa.me/393331112233?text=Ciao%20%26%20grazie")
    expect(whatsappLink("0039 333 111 2233", "x")).toBe("https://wa.me/393331112233?text=x")
    for (const bad of [null, "", "12", "abc", "1".repeat(20)]) expect(whatsappLink(bad, "x")).toBeNull()
  })
})

const settings: ActionSettings = {
  stages: [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "booked", label: "Booked" }, { key: "not_in_target", label: "Not in target" }],
  reasons: [{ key: "other", label: "Other" }], checklist: [],
  outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
}
const NOW = new Date("2026-10-20T10:00:00Z")
const setter: Actor = { id: "u", email: "cristina@x.com", role: "member" }
const free = (status: string) => ({ claimed_by: null, status })

describe("reaching-out actions", () => {
  it("need only the 'mark' permission", () => {
    for (const a of ["whatsapp", "no_answer", "appointment"] as const) expect(permissionFor(a)).toBe("leads.mark")
  })
  it("the first WhatsApp / no-answer moves a brand-new lead to 'contacted'; a lead already further along stays", () => {
    const w = planLeadAction({ action: "whatsapp", state: "sent", template: "first_contact" }, free("new"), setter, settings, NOW)
    expect(w).toMatchObject({ ok: true, change: { patch: { status: "contacted" }, event: { kind: "whatsapp", data: { state: "sent", template: "first_contact" } } } })
    expect(planLeadAction({ action: "no_answer", via: "call" }, free("new"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "contacted" }, event: { kind: "attempt", data: { result: "no_answer", via: "call" } } } })
    expect(planLeadAction({ action: "no_answer", via: "call" }, free("qualified"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {} } })
    expect(planLeadAction({ action: "whatsapp", state: "no_wa" }, free("not_in_target"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {} } })
  })
  it("a lead somebody else picked is theirs", () => {
    expect(planLeadAction({ action: "whatsapp", state: "sent" }, { claimed_by: "other", status: "new" }, setter, settings, NOW)).toMatchObject({ ok: false, status: 409 })
  })
  it("a booked call: checks the time, moves to 'booked' unless already there / past it / out of target, and can be cancelled", () => {
    const at = "2026-10-26T09:00:00.000Z"
    expect(planLeadAction({ action: "appointment", at }, free("contacted"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "booked" }, event: { kind: "appointment", data: { at } } } })
    expect(planLeadAction({ action: "appointment", at }, free("booked"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {} } })
    expect(planLeadAction({ action: "appointment", at }, free("not_in_target"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {} } })
    expect(planLeadAction({ action: "appointment", at: "2026-10-01T09:00:00.000Z" }, free("new"), setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "appointment", at: "2027-12-01T09:00:00.000Z" }, free("new"), setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "appointment", at: "nope" }, free("new"), setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "appointment", at: null }, free("booked"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {}, event: { data: { at: null } } } })
  })
  it("the request is validated (a bad state or channel is refused)", () => {
    expect(leadActionSchema.safeParse({ action: "whatsapp", state: "maybe" }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "no_answer", via: "pigeon" }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "no_answer" }).success).toBe(true)
    expect(leadActionSchema.safeParse({ action: "appointment", at: null }).success).toBe(true)
  })
  it("history lines", () => {
    expect(eventText("whatsapp", { state: "sent" }, [], [])).toBe("WhatsApp sent")
    expect(eventText("whatsapp", { state: "no_wa" }, [], [])).toMatch(/No WhatsApp/)
    expect(eventText("attempt", { result: "no_answer", via: "whatsapp" }, [], [])).toBe("No answer (WhatsApp)")
    expect(eventText("appointment", { at: null }, [], [])).toBe("Booked call cancelled")
    expect(eventText("appointment", { at: "2026-10-26T09:00:00.000Z" }, [], [])).toMatch(/Call booked for 26 Oct 2026/)
  })
})
