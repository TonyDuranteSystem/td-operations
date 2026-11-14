import { describe, it, expect } from "vitest"
import { decideLinkPlan, type PersonState, type LinkPlan } from "@/lib/booking/plan"
import { describePlan } from "@/lib/booking/preview"
import { parseBookingTemplates, templateFor } from "@/lib/booking/templates"

const META = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true, sort_order: 10 },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 20 },
  partner: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false, sort_order: 30 },
  private: { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false, sort_order: 40 },
}
const KIND = (slug: keyof typeof META, label = slug[0].toUpperCase() + slug.slice(1)) => ({ slug, label, metadata: META[slug] })

function plan(slug: keyof typeof META, state: PersonState, minutes: unknown = 30, firstBookingOnly?: boolean): LinkPlan {
  const r = decideLinkPlan({ person: { state, established: state === "contact" ? true : undefined }, kind: KIND(slug), minutes, firstBookingOnly })
  if ("errors" in r) throw new Error(r.errors.join("; "))
  return r.plan
}
const text = (lines: Array<{ label: string; text: string }>) => lines.map((l) => `${l.label}: ${l.text}`).join("\n")

describe("decideLinkPlan: the first-booking-only tick (Stage 1b)", () => {
  it("a standard 30-minute link is reusable unless the tick is on", () => {
    expect(plan("client", "contact", 30).once).toBe(false)
    expect(plan("client", "contact", 30, false).once).toBe(false)
    expect(plan("client", "contact", 30, true).once).toBe(true)
  })
  it("any other length is one-time whatever the tick says", () => {
    expect(plan("client", "contact", 45, false).once).toBe(true)
    expect(plan("client", "contact", "90").once).toBe(true)
  })
})

describe("describePlan: the words of the approved mockup, only what the engine does", () => {
  it("a client's call: saved on the contact page, no lead", () => {
    const t = text(describePlan({ plan: plan("client", "contact"), personState: "contact", personName: "Maria Rossi", hasEmails: true }))
    expect(t).toContain("A Zoom call, 30 minutes. No sales questions.")
    expect(t).toContain("saved on Maria Rossi's contact page, under Calls")
    expect(t).toContain("No lead is created")
    expect(t).toContain("If a different email books, the booking is saved as usual and a card asks you. It is never dropped.")
  })
  it("a name ending in s gets the plain apostrophe", () => {
    expect(text(describePlan({ plan: plan("client", "contact"), personState: "contact", personName: "Carlos", hasEmails: true }))).toContain("Carlos' contact page")
  })
  it("someone new on a lead kind: new lead + the sales questions", () => {
    const t = text(describePlan({ plan: plan("lead", "new"), personState: "new", personName: null, hasEmails: false }))
    expect(t).toContain("The person answers your sales questions first.")
    expect(t).toContain("A new lead appears in Leads.")
    expect(t).toContain("There is no email to compare with, so every booking on this link is treated the same way.")
  })
  it("a partner request: the new lead is marked Partner", () => {
    const t = text(describePlan({ plan: plan("partner", "new"), personState: "new", personName: "Northwind", hasEmails: true }))
    expect(t).toContain("marked Partner")
    expect(t).toContain("No new kind of record is added.")
  })
  it("a person who is only a lead: added to that lead, no duplicate", () => {
    const t = text(describePlan({ plan: plan("lead", "lead"), personState: "lead", personName: "Daniel Green", hasEmails: true }))
    expect(t).toContain("added to Daniel Green's lead")
    expect(t).toContain("No duplicate lead is made. Same as today.")
  })
  it("a private call: nothing is created and the recording still goes through", () => {
    const t = text(describePlan({ plan: plan("private", "new"), personState: "new", personName: null, hasEmails: false }))
    expect(t).toContain("Nothing is created.")
    expect(t).toContain("Still transcribed and filed with your other Zoom calls.")
  })
  it("a contact on the Lead kind is told the truth: it becomes a lead, as today", () => {
    expect(text(describePlan({ plan: plan("lead", "contact"), personState: "contact", personName: "Maria Rossi", hasEmails: true }))).toContain("tagged as an existing client's call")
  })
  it("length and use lines", () => {
    expect(text(describePlan({ plan: plan("client", "contact", 90), personState: "contact", personName: "A", hasEmails: true }))).toContain("A Zoom call, 90 minutes.")
    expect(text(describePlan({ plan: plan("client", "contact", 90), personState: "contact", personName: "A", hasEmails: true }))).toContain("one-time Calendly link")
    expect(text(describePlan({ plan: plan("client", "contact", 60), personState: "contact", personName: "A", hasEmails: true }))).toContain("A Zoom call, 1 hour.")
    expect(text(describePlan({ plan: plan("client", "contact", 120), personState: "contact", personName: "A", hasEmails: true }))).toContain("2 hours")
    expect(text(describePlan({ plan: plan("client", "contact", 30, true), personState: "contact", personName: "A", hasEmails: true }))).toContain("Attached to the first booking only")
    expect(text(describePlan({ plan: plan("client", "contact", 30, false), personState: "contact", personName: "A", hasEmails: true }))).toContain("The link stays open")
  })
  it("never mentions money, a referrer or the unbuilt week calendar's cards", () => {
    for (const slug of ["lead", "client", "partner", "private"] as const) {
      for (const state of ["new", "lead", "contact"] as const) {
        const t = text(describePlan({ plan: plan(slug, state), personState: state, personName: "X", hasEmails: true })).toLowerCase()
        expect(t).not.toMatch(/pay|credit|referr|which client/)
      }
    }
  })
  it("never says the booking 'shows on your calendar' (the Booking page has no calendar of its own yet, and the day-to-day Calendar is another page)", () => {
    for (const slug of ["lead", "client", "partner", "private"] as const) {
      for (const state of ["new", "lead", "contact"] as const) {
        expect(text(describePlan({ plan: plan(slug, state), personState: state, personName: "X", hasEmails: true })).toLowerCase()).not.toMatch(/calendar/)
      }
    }
  })
  it("uses no vendor jargon", () => {
    const t = text(describePlan({ plan: plan("lead", "new", 45), personState: "new", personName: null, hasEmails: false }))
    expect(t).not.toMatch(/utm|snapshot|slug|event type|webhook|invitee/i)
  })
})

describe("parseBookingTemplates", () => {
  const ok = { event_type_uri: "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", scheduling_url: "https://calendly.com/x/new-meeting" }
  it("reads both templates", () => {
    const t = parseBookingTemplates({ sales: ok, plain: ok })
    expect(templateFor(t, "plain")).toEqual({ eventTypeUri: ok.event_type_uri, schedulingUrl: ok.scheduling_url })
    expect(templateFor(t, "sales")).not.toBeNull()
  })
  it("a template that is not a plain calendly.com address, or has a bad event type address, is not set up", () => {
    for (const bad of [
      { ...ok, scheduling_url: "https://evil.example/x" },
      { ...ok, scheduling_url: "http://calendly.com/x" },
      { ...ok, event_type_uri: "https://calendly.com/x" },
      { ...ok, event_type_uri: "https://api.calendly.com/event_types/short" },
      { scheduling_url: ok.scheduling_url },
      null, "text", 5,
    ]) {
      expect(templateFor(parseBookingTemplates({ plain: bad }), "plain")).toBeNull()
    }
  })
  it("missing / malformed settings = nothing set up", () => {
    for (const raw of [null, undefined, [], "x", 1, {}]) expect(parseBookingTemplates(raw)).toEqual({})
  })
})
