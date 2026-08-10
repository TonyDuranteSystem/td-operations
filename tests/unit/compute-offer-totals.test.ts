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
  computeOfferPayable,
  resolveOfferCurrency,
  ambiguousDotPrices,} from "@/lib/offers/compute-offer-totals"

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

describe("countedServiceNames — checkout charge labels", () => {
  it("lists exactly the counted lines (skips recurring/included/deselected/zero)", () => {
    const t = computeOfferTotals({
      services: [
        { name: "Company Formation", price: "$3,000" },
        { name: "ITIN", price: "$1,000", optional: true },
        { name: "Annual", price: "$500/year" },
        { name: "RA", price: "included" },
        { name: "Freebie", price: "TBD" },
      ],
      cost_summary: [{ total: "$3,000" }],
      selected_services: [],
    })
    expect(t.countedServiceNames).toEqual(["Company Formation"])
  })
})

describe("ComputeOptions — contract-page semantics (WS-A3 sites #5-6)", () => {
  const multiContract = {
    services: [
      { name: "Company Formation", price: "€3,000", contract_type: "formation" },
      { name: "ITIN Application", price: "€1,000", contract_type: "itin" },
      { name: "Notary", price: "€200" }, // no contract_type → belongs to the main contract
    ],
    cost_summary: [{ label: "Setup Fee", total: "€4,200" }],
    selected_services: [],
  }

  it("filterContractType counts only the main contract's lines (+ untyped ones)", () => {
    expect(computeOfferTotals(multiContract, { filterContractType: "formation" }).gross).toBe(3200)
    expect(computeOfferTotals(multiContract, { filterContractType: "itin" }).gross).toBe(1200)
  })

  it("without the filter, EVERY selected line counts (offer page / webhook / checkout)", () => {
    expect(computeOfferTotals(multiContract).gross).toBe(4200)
  })

  it("currencyOverride wins over header sniffing (the contract pages' explicit-column rule)", () => {
    const eurHeader = { services: [{ name: "X", price: "1000" }], cost_summary: [{ total: "€1,000" }] }
    expect(computeOfferTotals(eurHeader).currency).toBe("EUR")
    expect(computeOfferTotals(eurHeader, { currencyOverride: "USD" }).currency).toBe("USD")
    // null/undefined override falls back to header detection
    expect(computeOfferTotals(eurHeader, { currencyOverride: null }).currency).toBe("EUR")
  })
})

// ─── NET EVERYWHERE + one currency rule (blockers 1 & 2) ─────────────────

describe("computeOfferPayable — the single amount authority", () => {
  it("net = gross − credit, and that is what every rail must charge", () => {
    const p = computeOfferPayable({
      services: [{ name: "Formation", price: "€1500" }],
      cost_summary: [{ label: "Totale", total: "€1500" }],
      currency: "EUR",
      credit_amount: 257,
    })
    expect(p.gross).toBe(1500)
    expect(p.credit).toBe(257)
    expect(p.net).toBe(1243)
  })

  it("a credit larger than the bill nets to zero, never negative", () => {
    const p = computeOfferPayable({
      services: [{ name: "Small", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      currency: "USD",
      credit_amount: 257,
    })
    expect(p.net).toBe(0)
    expect(p.credit).toBe(100)   // capped at what is owed
  })

  it("no credit leaves the amount exactly as it was — no behaviour change", () => {
    const p = computeOfferPayable({
      services: [{ name: "Formation", price: "$1,500" }],
      cost_summary: [{ label: "Total", total: "$1,500" }],
    })
    expect(p.gross).toBe(1500)
    expect(p.credit).toBe(0)
    expect(p.net).toBe(1500)
  })

  it("junk in the credit column cannot corrupt the amount charged", () => {
    for (const bad of [null, undefined, "abc", -50, NaN]) {
      const p = computeOfferPayable({
        services: [{ name: "F", price: "$100" }],
        cost_summary: [{ label: "Total", total: "$100" }],
        credit_amount: bad as never,
      })
      expect(p.net).toBe(100)
      expect(p.credit).toBe(0)
    }
  })
})

describe("resolveOfferCurrency — ONE rule for storage, engine and credit", () => {
  it("an explicit currency on the offer wins over any sniffing", () => {
    expect(resolveOfferCurrency("EUR", [{ label: "Total", total: "$1,500" }])).toBe("EUR")
    expect(resolveOfferCurrency("USD", [{ label: "Totale", total: "€1.500" }])).toBe("USD")
  })

  it("falls back to the header when the offer never recorded one", () => {
    expect(resolveOfferCurrency(null, [{ label: "Totale", total: "€1.500" }])).toBe("EUR")
    expect(resolveOfferCurrency(undefined, [{ label: "Total", total: "$1,500" }])).toBe("USD")
  })

  it("BLOCKER 2: a '$/year' recurring line in the SERVICES can no longer flip a EUR offer", () => {
    // The old storage detector sniffed the whole services blob; the engine read
    // the header. That split stored EUR and charged USD.
    const summary = [{ label: "Totale", total: "€1.500" }]
    const services = [{ name: "Annual Maintenance", price: "$2,000/year" }]
    expect(resolveOfferCurrency(null, summary)).toBe("EUR")
    // the engine agrees, because it now asks the same function
    expect(computeOfferPayable({ services, cost_summary: summary }).currency).toBe("EUR")
  })

  it("storage and the money engine cannot disagree — the same input gives the same answer", () => {
    const cases: Array<[string | null, unknown]> = [
      ["EUR", [{ label: "Total", total: "$900" }]],
      [null, [{ label: "Totale", total: "€900" }]],
      [null, [{ label: "Total", total: "900" }]],
    ]
    for (const [explicit, summary] of cases) {
      const stored = resolveOfferCurrency(explicit, summary)
      const engine = computeOfferPayable({ services: [], cost_summary: summary, currency: explicit }).currency
      expect(engine).toBe(stored)
    }
  })
})

// ─── the authoring warning for dot-thousands prices (approved rider) ──────

describe("ambiguousDotPrices — catch it while it is still being typed", () => {
  it("flags the exact shape that mis-prices: dot + three digits", () => {
    const hits = ambiguousDotPrices([{ name: "Costituzione LLC", price: "€1.500" }])
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain("Costituzione LLC")
    // and it really is the shape that breaks — proven against the parser itself
    expect(parsePriceQuirk("€1.500")).toBe(1.5)
  })

  it("flags dollars and bare numbers written the same way", () => {
    expect(ambiguousDotPrices([{ name: "A", price: "$1.500" }]).length).toBe(1)
    expect(ambiguousDotPrices([{ name: "B", price: "1.500" }]).length).toBe(1)
    expect(ambiguousDotPrices([{ name: "C", price: "€12.345" }]).length).toBe(1)
  })

  it("does NOT flag a genuine decimal — two digits after the dot is money", () => {
    expect(ambiguousDotPrices([{ name: "A", price: "€1.50" }])).toEqual([])
    expect(ambiguousDotPrices([{ name: "B", price: "$99.99" }])).toEqual([])
  })

  it("does NOT flag the formats that parse correctly today", () => {
    expect(ambiguousDotPrices([{ name: "A", price: "$1,500" }])).toEqual([])
    expect(ambiguousDotPrices([{ name: "B", price: "€1500" }])).toEqual([])
    expect(ambiguousDotPrices([{ name: "C", price: "Inclusa" }])).toEqual([])
    expect(ambiguousDotPrices([{ name: "D", price: "" }])).toEqual([])
  })

  it("reports every offending line, not just the first", () => {
    const hits = ambiguousDotPrices([
      { name: "One", price: "€1.500" },
      { name: "Two", price: "$1,500" },
      { name: "Three", price: "€2.500" },
    ])
    expect(hits.length).toBe(2)
  })

  it("survives junk without throwing", () => {
    expect(ambiguousDotPrices(null)).toEqual([])
    expect(ambiguousDotPrices("nonsense")).toEqual([])
    expect(ambiguousDotPrices([{ name: "A" }])).toEqual([])
  })
})

// ─── the columns the money rails must actually FETCH ─────────────────────
// The checkout shipped reading `credit_amount` off a row it never selected.
// The reads were `as`-cast, so the compiler saw nothing and the card charged
// the gross — the exact bug this workstream exists to fix, live in production.
// These pin the contract: a rail that forgets the column gets caught here.

describe("a money rail must SUPPLY the credit, not just read for it", () => {
  it("an offer row missing credit_amount charges the GROSS — the failure shape", () => {
    const rowAsFetchedWithoutCredit = {
      services: [{ name: "Formation", price: "€1,575" }],
      cost_summary: [{ label: "Totale", total: "€1,575" }],
      currency: "EUR",
      // credit_amount deliberately absent, exactly as the broken select returned it
    }
    const p = computeOfferPayable(rowAsFetchedWithoutCredit)
    expect(p.net).toBe(1575)
    expect(p.credit).toBe(0)
  })

  it("the same offer WITH the column supplied charges the net", () => {
    const p = computeOfferPayable({
      services: [{ name: "Formation", price: "€1,575" }],
      cost_summary: [{ label: "Totale", total: "€1,575" }],
      currency: "EUR",
      credit_amount: 257,
    })
    expect(p.credit).toBe(257)
    expect(p.net).toBe(1318)
  })

  it("a fully covered offer nets to zero — no card link should be minted for it", () => {
    const p = computeOfferPayable({
      services: [{ name: "ITIN", price: "€250" }],
      cost_summary: [{ label: "Totale", total: "€250" }],
      currency: "EUR",
      credit_amount: 257,
    })
    expect(p.net).toBe(0)
  })
})

describe("WS-C: dueNow — what a rail charges when the fee is paid in parts", () => {
  /** Domenico's deal, as an offer row: EUR2,500 itemised, split EUR1,250 + EUR1,250. */
  const planned = {
    services: [{ name: "LLC Formation", price: "€2,500" }],
    cost_summary: [{ label: "Setup Fee", total: "€2,500" }],
    payment_plan: [
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
      { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual", label: "Bank account opened (Relay)" } },
    ],
  }

  it("charges the signing part, while the offer still states the whole commitment", () => {
    const p = computeOfferPayable(planned)
    expect(p.gross).toBe(2500) // what the client agreed to
    expect(p.net).toBe(2500) // what they owe in total
    expect(p.dueNow).toBe(1250) // what the card / wire collects today
    expect(p.hasPaymentPlan).toBe(true)
    expect(p.planRefusal).toBe(null)
  })

  it("⛔ an ordinary offer is untouched: dueNow IS net", () => {
    // The whole safety of this change rests on this cell. Every rail switching from `net` to
    // `dueNow` must be a no-op for the offers that exist today — payment_plan is non-null on
    // zero production offers.
    const p = computeOfferPayable({
      services: [{ name: "Formation", price: "$1,500" }],
      cost_summary: [{ label: "Setup", total: "$1,500" }],
      credit_amount: 257,
    })
    expect(p.hasPaymentPlan).toBe(false)
    expect(p.planRefusal).toBe(null)
    expect(p.net).toBe(1243)
    expect(p.dueNow).toBe(1243)
  })

  it("credit comes off TODAY's part, not the far end of the plan", () => {
    // A client who already paid for the strategy call owes that much less now. Netting it
    // against the EUR2,500 commitment and still charging EUR1,250 today would collect money
    // they do not owe — the WS-A defect in a new costume.
    const p = computeOfferPayable({ ...planned, credit_amount: 250 })
    expect(p.credit).toBe(250)
    expect(p.dueNow).toBe(1000)
    expect(p.net).toBe(2250)
  })

  it("a credit larger than the first part spills forward instead of going negative", () => {
    const p = computeOfferPayable({ ...planned, credit_amount: 1400 })
    expect(p.dueNow).toBe(0) // nothing to collect at signing
    expect(p.net).toBe(1100) // and EUR1,100 of the commitment remains
  })

  it("a plan with no signing part owes nothing today — zero, not the total", () => {
    const p = computeOfferPayable({
      ...planned,
      payment_plan: [
        { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "manual" } },
        { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual" } },
      ],
    })
    expect(p.dueNow).toBe(0)
    expect(p.planRefusal).toBe(null)
  })
})

describe("⛔ WS-C: a plan that contradicts its offer REFUSES — it never picks a winner", () => {
  const base = {
    services: [{ name: "LLC Formation", price: "€2,500" }],
    cost_summary: [{ label: "Setup Fee", total: "€2,500" }],
  }

  it("refuses when the parts do not add up to the offer", () => {
    const p = computeOfferPayable({
      ...base,
      payment_plan: [
        { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
        { seq: 2, amount: 900, currency: "EUR", trigger: { kind: "manual" } },
      ],
    })
    expect(p.planRefusal).toContain("2150")
    expect(p.planRefusal).toContain("2500")
    // The pre-plan number stays put so nothing crashes — but the refusal is what a rail reads.
    expect(p.dueNow).toBe(2500)
  })

  it("refuses when the plan is in a different currency from the offer", () => {
    const p = computeOfferPayable({
      ...base,
      payment_plan: [
        { seq: 1, amount: 1250, currency: "USD", trigger: { kind: "signing" } },
        { seq: 2, amount: 1250, currency: "USD", trigger: { kind: "manual" } },
      ],
    })
    expect(p.planRefusal).toContain("USD")
    expect(p.planRefusal).toContain("EUR")
  })

  it("refuses a malformed plan, and says what is wrong with it", () => {
    const p = computeOfferPayable({ ...base, payment_plan: [{ seq: 1, amount: 2500 }] })
    expect(p.hasPaymentPlan).toBe(true)
    expect(p.planRefusal).toBeTruthy()
    expect(p.planRefusal).toContain("not usable")
  })

  it("tolerates rounding dust rather than refusing over a cent", () => {
    const p = computeOfferPayable({
      services: [{ name: "Formation", price: "$1,000" }],
      cost_summary: [{ label: "Setup", total: "$1,000" }],
      payment_plan: [
        { seq: 1, amount: 333.33, currency: "USD", trigger: { kind: "signing" } },
        { seq: 2, amount: 333.33, currency: "USD", trigger: { kind: "manual" } },
        { seq: 3, amount: 333.34, currency: "USD", trigger: { kind: "manual" } },
      ],
    })
    expect(p.planRefusal).toBe(null)
    expect(p.dueNow).toBe(333.33)
  })
})
