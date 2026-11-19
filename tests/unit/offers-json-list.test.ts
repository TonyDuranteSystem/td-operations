/**
 * Offer lists saved as text (dev job 20600f18). One old offer had its price breakdown and services saved as a
 * JSON string; the staff contact page did `.map` on it and fell to the red error screen. These pin the shared
 * reader (display side) and the write-side normaliser (so a new offer can never be stored this way).
 */
import { describe, it, expect } from "vitest"
import { listOrEmpty, normalizeOfferLists, OFFER_LIST_FIELDS } from "@/lib/offers/json-list"
import { computeOfferTotals, resolveOfferCurrency } from "@/lib/offers/compute-offer-totals"

const GROUPS = [
  { label: "Setup Iniziale (2026)", total: "€3.000", items: [{ name: "Chiusura Delaware + Nuova LLC New Mexico", price: "€3.000" }] },
  { label: "Gestione Annuale (dal 2027)", total: "$2.000/anno" },
]

describe("listOrEmpty", () => {
  it("keeps a real list as it is", () => {
    expect(listOrEmpty(GROUPS)).toBe(GROUPS)
  })

  it("reads a list saved as text — the exact shape that crashed the contact page", () => {
    const asText = JSON.stringify(GROUPS)
    const out = listOrEmpty<{ label: string }>(asText)
    expect(Array.isArray(out)).toBe(true)
    expect(out.map((g) => g.label)).toEqual(["Setup Iniziale (2026)", "Gestione Annuale (dal 2027)"])
    // `.map` / `.filter` work on the result — the crash was `.map` on text
    expect(() => out.map((g) => g.label)).not.toThrow()
  })

  it("is empty, never a throw, for anything that is not a list", () => {
    for (const bad of [null, undefined, "", "not json", "{\"a\":1}", "42", 42, true, { a: 1 }]) {
      expect(listOrEmpty(bad)).toEqual([])
    }
  })

  it("a double-encoded list (text inside text) is NOT silently unwrapped twice", () => {
    // The prod row was a jsonb string holding a JSON array, which reaches the code as ONE level of text.
    // Two levels of encoding is not a known shape; showing nothing beats guessing.
    expect(listOrEmpty(JSON.stringify(JSON.stringify(GROUPS)))).toEqual([])
  })
})

describe("normalizeOfferLists", () => {
  it("turns a list sent as text into the real list and says which field it fixed", () => {
    const r = normalizeOfferLists({ cost_summary: JSON.stringify(GROUPS), services: JSON.stringify([{ name: "X", price: "$1" }]) })
    expect(r.ok).toBe(true)
    expect(r.values.cost_summary).toEqual(GROUPS)
    expect(r.values.services).toEqual([{ name: "X", price: "$1" }])
    expect(r.fixed.sort()).toEqual(["cost_summary", "services"])
  })

  it("leaves real lists, empty values and unrelated fields alone", () => {
    const r = normalizeOfferLists({ cost_summary: GROUPS, services: null, recurring_costs: undefined, client_name: "Mario", issues: "" })
    expect(r.ok).toBe(true)
    expect(r.values).toEqual({})
    expect(r.fixed).toEqual([])
  })

  it("only looks at fields it is given — an update that does not mention a field never gets it added", () => {
    const r = normalizeOfferLists({ client_email: "a@b.com" })
    expect(r).toEqual({ ok: true, values: {}, fixed: [], error: null })
  })

  it("refuses text that is not a list, with a plain message naming the field", () => {
    for (const bad of ["not json", "{\"a\":1}", "42"]) {
      const r = normalizeOfferLists({ cost_summary: bad })
      expect(r.ok).toBe(false)
      expect(r.error).toContain("cost_summary")
      expect(r.error).toContain("not a list")
      expect(r.values).toEqual({})
    }
  })

  it("does not change the object it is given", () => {
    const input = { cost_summary: JSON.stringify(GROUPS) }
    normalizeOfferLists(input)
    expect(typeof input.cost_summary).toBe("string")
  })

  it("covers every list field the offer validator knows", () => {
    expect([...OFFER_LIST_FIELDS].sort()).toEqual(
      ["additional_services", "cost_summary", "future_developments", "immediate_actions", "issues", "next_steps", "recurring_costs", "services", "strategy"],
    )
  })
})

describe("the money readers still treat a text-saved price breakdown the same as a list", () => {
  it("resolveOfferCurrency reads the header of a list saved as text", () => {
    expect(resolveOfferCurrency(null, JSON.stringify(GROUPS))).toBe("EUR")
    expect(resolveOfferCurrency(null, GROUPS)).toBe("EUR")
  })

  it("computeOfferTotals gives the same answer for text and for the real list", () => {
    const base = { services: [], selected_services: null }
    const fromList = computeOfferTotals({ ...base, cost_summary: GROUPS } as never)
    const fromText = computeOfferTotals({ ...base, cost_summary: JSON.stringify(GROUPS) } as never)
    expect(fromText).toEqual(fromList)
  })
})
