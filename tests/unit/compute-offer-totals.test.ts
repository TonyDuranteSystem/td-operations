/**
 * WS-A3 characterization suite (dev job c0a61e44) — pins the CURRENT
 * offer-signed webhook parser semantics, quirks included, BEFORE any of the
 * ~25 call sites migrates to the shared calculator. A failing test here after
 * a "cleanup" means real offers would re-price — that is the incident class
 * this suite exists to prevent.
 */
import { describe, it, expect } from "vitest"
import {
  computeOfferTotals,
  computeNetOfCredits,
  parsePriceQuirk,
} from "@/lib/offers/compute-offer-totals"

describe("parsePriceQuirk — the historical parser, verbatim", () => {
  it("parses plain prices with symbols and commas", () => {
    expect(parsePriceQuirk("$1,500")).toBe(1500)
    expect(parsePriceQuirk("€3000")).toBe(3000)
    expect(parsePriceQuirk("2500")).toBe(2500)
  })
  it("QUIRK (pinned): strips minus signs — a negative line ADDS", () => {
    expect(parsePriceQuirk("-€257")).toBe(257)
  })
  it("QUIRK (pinned): EU dot-thousands break at service level — €1.500 → 1.5", () => {
    expect(parsePriceQuirk("€1.500")).toBe(1.5)
  })
  it("junk → 0", () => {
    expect(parsePriceQuirk("TBD")).toBe(0)
    expect(parsePriceQuirk(null)).toBe(0)
    expect(parsePriceQuirk(undefined)).toBe(0)
  })
})

describe("computeOfferTotals — webhook semantics", () => {
  const base = {
    services: [
      { name: "Company Formation", price: "$3,000" },
      { name: "ITIN", price: "$1,000", optional: true },
      { name: "Annual Maintenance", price: "$500/year" },
      { name: "Registered Agent", price: "included" },
    ],
    cost_summary: [{ label: "Setup Fee", total: "$4,000", items: [] }],
    selected_services: ["ITIN"],
  }

  it("sums selected one-time lines; skips recurring + included", () => {
    const t = computeOfferTotals(base)
    expect(t.servicesTotal).toBe(4000)
    expect(t.gross).toBe(4000)
    expect(t.source).toBe("lines")
  })

  it("deselected optional services are excluded", () => {
    const t = computeOfferTotals({ ...base, selected_services: [] })
    expect(t.servicesTotal).toBe(3000)
  })

  it("Italian recurring markers (/anno, /mese) are skipped too", () => {
    const t = computeOfferTotals({
      services: [
        { name: "Formazione", price: "€2.000" }, // EU quirk → 2
        { name: "Gestione", price: "€600/anno" },
        { name: "Extra", price: "€50/mese" },
      ],
      cost_summary: [{ label: "Setup", total: "€2.000" }],
      selected_services: [],
    })
    expect(t.servicesTotal).toBe(2) // pinned EU quirk at line level
    expect(t.currency).toBe("EUR")
  })

  it("pre-condition groups add to the total", () => {
    const t = computeOfferTotals({
      services: [{ name: "Formation", price: "$1,000" }],
      cost_summary: [
        { label: "Setup Fee", total: "$1,350" },
        { label: "Pre-conditions (to be resolved)", items: [{ name: "Unpaid taxes", price: "$350" }] },
      ],
      selected_services: [],
    })
    expect(t.preconditionsTotal).toBe(350)
    expect(t.gross).toBe(1350)
  })

  it("fallback: zero-parse services → cost_summary[0].total, EU dot-thousands handled (1.500 → 1500)", () => {
    const t = computeOfferTotals({
      services: [{ name: "Consulenza", price: "prezzo su richiesta" }],
      cost_summary: [{ label: "Setup", total: "€1.500" }],
      selected_services: [],
    })
    expect(t.gross).toBe(1500)
    expect(t.source).toBe("summary_fallback")
    expect(t.currency).toBe("EUR")
  })

  it("fallback with comma-thousands strips the comma (1,500 → 1500)", () => {
    const t = computeOfferTotals({
      services: [],
      cost_summary: [{ label: "Setup", total: "$1,500" }],
    })
    expect(t.gross).toBe(1500)
  })

  it("currency = header €/EUR → EUR else USD (the money-of-record variant)", () => {
    expect(computeOfferTotals({ services: [], cost_summary: [{ total: "EUR 900" }] }).currency).toBe("EUR")
    expect(computeOfferTotals({ services: [], cost_summary: [{ total: "$900" }] }).currency).toBe("USD")
    // DOCUMENTED DIVERGENCE: the offer PAGE sniffs price strings instead; the
    // header (this) variant is authoritative and sites unify toward it.
    expect(computeOfferTotals({ services: [{ name: "X", price: "€100" }], cost_summary: [{ total: "100" }] }).currency).toBe("USD")
  })

  it("stringified cost_summary JSON is parsed (legacy rows); junk JSON → empty", () => {
    expect(
      computeOfferTotals({ services: [], cost_summary: '[{"label":"Setup","total":"$700"}]' }).gross,
    ).toBe(700)
    expect(computeOfferTotals({ services: [], cost_summary: "not json" }).gross).toBe(0)
  })

  it("nothing parseable anywhere → gross 0, source none (caller decides)", () => {
    const t = computeOfferTotals({ services: [], cost_summary: [] })
    expect(t).toMatchObject({ gross: 0, source: "none" })
  })
})

describe("computeNetOfCredits — locked decision D3 (same-currency only)", () => {
  it("applies a same-currency credit; never negative", () => {
    expect(computeNetOfCredits(4000, "EUR", [{ amount: 257, currency: "EUR" }])).toMatchObject({
      appliedCredits: 257,
      net: 3743,
      skippedCrossCurrency: 0,
    })
  })
  it("cross-currency credits are SKIPPED and reported, never converted", () => {
    expect(computeNetOfCredits(4000, "USD", [{ amount: 257, currency: "EUR" }])).toMatchObject({
      appliedCredits: 0,
      net: 4000,
      skippedCrossCurrency: 257,
    })
  })
  it("credit larger than gross caps at gross → net 0 (fully covered)", () => {
    expect(computeNetOfCredits(200, "EUR", [{ amount: 257, currency: "EUR" }])).toMatchObject({
      appliedCredits: 200,
      net: 0,
    })
  })
  it("multiple credits sum; zero/negative amounts ignored", () => {
    expect(
      computeNetOfCredits(1000, "USD", [
        { amount: 157, currency: "USD" },
        { amount: 0, currency: "USD" },
        { amount: -50, currency: "USD" },
        { amount: 100, currency: "USD" },
      ]),
    ).toMatchObject({ appliedCredits: 257, net: 743 })
  })
})
