import { describe, it, expect } from "vitest"
import { buildAnnualMaintenanceWording } from "@/lib/offers/annual-maintenance-wording"

// The real rows of a live formation offer (Stefano Stella, 2026-09-28).
const USD_ROWS = [
  { label: "1st Installment (January)", price: "$1000", currency: "USD" },
  { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
  { label: "Annual Total", price: "$2,000", currency: "USD" },
]

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12)

describe("buildAnnualMaintenanceWording — after-September rule", () => {
  it("signed in September: first payment is June next year, January+June from the year after", () => {
    const w = buildAnnualMaintenanceWording({ recurringCosts: USD_ROWS, currency: "USD", signDate: at(2026, 9, 28) })
    expect(w?.lines).toEqual([
      "June 2027: $1,000",
      "From 2028: $1,000 in January and $1,000 in June ($2,000 per year)",
    ])
  })

  it("September 1 itself already skips January", () => {
    const w = buildAnnualMaintenanceWording({ recurringCosts: USD_ROWS, currency: "USD", signDate: at(2026, 9, 1) })
    expect(w?.lines[0]).toBe("June 2027: $1,000")
  })

  it("signed in August: January and June from next year", () => {
    const w = buildAnnualMaintenanceWording({ recurringCosts: USD_ROWS, currency: "USD", signDate: at(2026, 8, 31) })
    expect(w?.lines).toEqual(["From 2027: $1,000 in January and $1,000 in June ($2,000 per year)"])
  })

  it("December signing skips the next January too", () => {
    const w = buildAnnualMaintenanceWording({ recurringCosts: USD_ROWS, currency: "USD", signDate: at(2026, 12, 20) })
    expect(w?.lines[0]).toBe("June 2027: $1,000")
    expect(w?.lines[1]).toMatch(/^From 2028:/)
  })

  it("never treats the Annual Total row as an installment", () => {
    const w = buildAnnualMaintenanceWording({ recurringCosts: USD_ROWS, currency: "USD", signDate: at(2026, 3, 1) })
    expect(w?.sentence).not.toMatch(/2,000 in/)
    expect(w?.sentence).toContain("($2,000 per year)")
  })
})

describe("buildAnnualMaintenanceWording — amounts and currency", () => {
  it("uses each row's own currency (EUR)", () => {
    const rows = [
      { label: "1st Installment (January)", price: "€1250", currency: "EUR" },
      { label: "2nd Installment (June)", price: "€1250", currency: "EUR" },
    ]
    const w = buildAnnualMaintenanceWording({ recurringCosts: rows, currency: "USD", signDate: at(2026, 2, 1) })
    expect(w?.lines).toEqual(["From 2027: €1,250 in January and €1,250 in June (€2,500 per year)"])
  })

  it("reads Italian labels and the amount field", () => {
    const rows = [
      { label: "Prima rata (Gennaio)", amount: "1000" },
      { label: "Seconda rata (Giugno)", amount: "1000" },
    ]
    const w = buildAnnualMaintenanceWording({ recurringCosts: rows, currency: "USD", signDate: at(2026, 10, 5) })
    expect(w?.lines[0]).toBe("June 2027: $1,000")
  })

  it("different January and June amounts are shown as they are", () => {
    const rows = [
      { label: "January", price: "$1500", currency: "USD" },
      { label: "June", price: "$500", currency: "USD" },
    ]
    const w = buildAnnualMaintenanceWording({ recurringCosts: rows, currency: "USD", signDate: at(2026, 4, 1) })
    expect(w?.lines).toEqual(["From 2027: $1,500 in January and $500 in June ($2,000 per year)"])
  })
})

describe("buildAnnualMaintenanceWording — falls back (null) for anything unusual", () => {
  it.each([
    ["no rows", []],
    ["not an array", null],
    ["only a total", [{ label: "Annual Total", price: "$2000" }]],
    ["only January", [{ label: "January", price: "$1000" }]],
    ["unlabelled rows", [{ label: "Fee A", price: "$1000" }, { label: "Fee B", price: "$1000" }]],
    ["zero amounts", [{ label: "January", price: "$0" }, { label: "June", price: "$0" }]],
  ])("%s → null", (_name, rows) => {
    expect(buildAnnualMaintenanceWording({ recurringCosts: rows, currency: "USD", signDate: at(2026, 9, 28) })).toBeNull()
  })
})
