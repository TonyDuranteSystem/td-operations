/**
 * What the Match popup can work out about who paid.
 *
 * The real case: a $125 Stripe payment from one sender whose earlier payments all went to one
 * company, where a $50 and a $75 invoice (both already Paid on the payment's date) add up to the
 * payment exactly. Delete the date ranking and the "closest dates first" test fails; delete the
 * claimed-by-other filter and the claimed test fails; let the paid total exceed the payment and
 * the mixed-split test fails.
 */
import { describe, it, expect } from "vitest"
import {
  normalizePayerName,
  parsePayerEmail,
  escapeLikePattern,
  isUsablePayerName,
  rankPayerCompanies,
  findExactCombos,
  daysApart,
  MAX_COMBO_POOL,
  MAX_COMBOS_SHOWN,
  type ComboInvoice,
} from "@/lib/finance/payer-suggestions"

const inv = (over: Partial<ComboInvoice> & { id: string }): ComboInvoice => ({
  amount: 50,
  currency: "USD",
  paid: true,
  paid_date: "2026-06-16",
  claimed_by_other: false,
  ...over,
})

describe("payer identity helpers", () => {
  it("normalizes case and spacing", () => {
    expect(normalizePayerName("  BILAAL   Rajan ")).toBe("bilaal rajan")
    expect(normalizePayerName(null)).toBe("")
  })

  it("reads the email a processor put in the memo", () => {
    expect(parsePayerEmail("email: rajan.aman@gmail.com | visa ••••9765")).toBe("rajan.aman@gmail.com")
    expect(parsePayerEmail("Email: Someone@Example.COM")).toBe("someone@example.com")
    expect(parsePayerEmail("email: | visa ••••9765")).toBeNull()
    expect(parsePayerEmail("wire from acme")).toBeNull()
    expect(parsePayerEmail(null)).toBeNull()
  })

  it("escapes LIKE wildcards so a sender name cannot widen the search", () => {
    expect(escapeLikePattern("100%_off\\x")).toBe("100\\%\\_off\\\\x")
    expect(escapeLikePattern("plain name")).toBe("plain name")
  })

  it("refuses names too short or empty to mean anything", () => {
    expect(isUsablePayerName("")).toBe(false)
    expect(isUsablePayerName("ach")).toBe(false)
    expect(isUsablePayerName("1234")).toBe(false)
    expect(isUsablePayerName("unknown")).toBe(false)
    expect(isUsablePayerName("mario")).toBe(false)
    expect(isUsablePayerName("mario rossi")).toBe(true)
    expect(isUsablePayerName("bilaal rajan")).toBe(true)
  })
})

describe("rankPayerCompanies", () => {
  it("ranks by how often the payer was linked there, then by recency", () => {
    const ranked = rankPayerCompanies([
      { account_id: "A", contact_id: null, transaction_date: "2026-02-26" },
      { account_id: "A", contact_id: null, transaction_date: "2026-09-16" },
      { account_id: "B", contact_id: null, transaction_date: "2026-10-01" },
      { account_id: "A", contact_id: null, transaction_date: "2026-07-14" },
      { account_id: "C", contact_id: null, transaction_date: "2026-10-20" },
    ])
    expect(ranked.map((c) => c.id)).toEqual(["A", "C", "B"])
    expect(ranked[0]).toMatchObject({ kind: "account", times_linked: 3, last_linked: "2026-09-16" })
  })

  it("falls back to the person when there is no company, and ignores rows with neither", () => {
    const ranked = rankPayerCompanies([
      { account_id: null, contact_id: "P", transaction_date: "2026-05-01" },
      { account_id: null, contact_id: null, transaction_date: "2026-05-02" },
    ])
    expect(ranked).toEqual([{ kind: "contact", id: "P", times_linked: 1, last_linked: "2026-05-01" }])
  })

  it("keeps a company and a person with the same id apart and respects the cap", () => {
    const rows = ["A", "B", "C", "D"].map((id) => ({ account_id: id, contact_id: null, transaction_date: "2026-01-01" }))
    expect(rankPayerCompanies(rows, 2)).toHaveLength(2)
    expect(rankPayerCompanies([], 3)).toEqual([])
  })
})

describe("findExactCombos", () => {
  it("finds the real case: $50 + $75 paid on the payment's date make the $125", () => {
    const combos = findExactCombos(125, "2026-06-16", "USD", [
      inv({ id: "002323", amount: 50, paid_date: "2026-06-16" }),
      inv({ id: "002121", amount: 75, paid_date: "2026-06-16" }),
      inv({ id: "002402", amount: 50, paid_date: "2026-07-14" }),
      inv({ id: "002434", amount: 52.5, paid_date: "2026-07-27" }),
    ])
    expect(combos[0].ids.sort()).toEqual(["002121", "002323"])
    expect(combos[0].total).toBe(125)
    expect(combos[0].dates_match).toBe(true)
  })

  it("puts the set paid on the payment's date ahead of an equally exact set paid months apart", () => {
    const combos = findExactCombos(125, "2026-06-16", "USD", [
      inv({ id: "old50", amount: 50, paid_date: "2026-02-01" }),
      inv({ id: "old75", amount: 75, paid_date: "2026-02-01" }),
      inv({ id: "new50", amount: 50, paid_date: "2026-06-16" }),
      inv({ id: "new75", amount: 75, paid_date: "2026-06-16" }),
    ])
    expect(combos[0].ids.sort()).toEqual(["new50", "new75"])
    expect(combos[0].dates_match).toBe(true)
    // The other exact sets are still offered, just not first and not claiming to match the date.
    expect(combos.some((c) => !c.dates_match)).toBe(true)
  })

  it("prefers fewer invoices when the dates tie", () => {
    const combos = findExactCombos(100, "2026-06-16", "USD", [
      inv({ id: "whole", amount: 100 }),
      inv({ id: "half1", amount: 50 }),
      inv({ id: "half2", amount: 50 }),
    ])
    expect(combos[0].ids).toEqual(["whole"])
  })

  it("never uses an invoice already tied to another transaction", () => {
    const combos = findExactCombos(125, "2026-06-16", "USD", [
      inv({ id: "a", amount: 50, claimed_by_other: true }),
      inv({ id: "b", amount: 75 }),
    ])
    expect(combos).toEqual([])
  })

  it("never mixes currencies", () => {
    const combos = findExactCombos(125, "2026-06-16", "USD", [
      inv({ id: "a", amount: 50 }),
      inv({ id: "b", amount: 75, currency: "EUR" }),
    ])
    expect(combos).toEqual([])
  })

  it("matches to the cent, not approximately, and survives float dust", () => {
    expect(findExactCombos(0.3, "2026-06-16", "USD", [inv({ id: "a", amount: 0.1 }), inv({ id: "b", amount: 0.2 })])[0].ids.sort()).toEqual(["a", "b"])
    expect(findExactCombos(125, "2026-06-16", "USD", [inv({ id: "a", amount: 50 }), inv({ id: "b", amount: 74.99 })])).toEqual([])
  })

  it("mixes paid and still-owed invoices when together they make the payment", () => {
    const combos = findExactCombos(125, "2026-06-16", "USD", [
      inv({ id: "paid", amount: 75, paid: true, paid_date: "2026-06-16" }),
      inv({ id: "open", amount: 50, paid: false, paid_date: null }),
    ])
    expect(combos[0].ids.sort()).toEqual(["open", "paid"])
  })

  it("ignores zero, negative and oversized amounts, and a zero payment", () => {
    expect(findExactCombos(0, "2026-06-16", "USD", [inv({ id: "a", amount: 50 })])).toEqual([])
    expect(findExactCombos(50, "2026-06-16", "USD", [inv({ id: "z", amount: 0 }), inv({ id: "n", amount: -50 }), inv({ id: "big", amount: 500 })])).toEqual([])
  })

  it("stays bounded: a big pool is cut and the result list is capped", () => {
    const many = Array.from({ length: 80 }, (_, i) => inv({ id: `i${String(i).padStart(3, "0")}`, amount: 25, paid_date: "2026-06-16" }))
    const combos = findExactCombos(100, "2026-06-16", "USD", many)
    expect(combos.length).toBeLessThanOrEqual(MAX_COMBOS_SHOWN)
    expect(combos[0].ids).toHaveLength(4)
    // Only the pool-size nearest invoices are ever considered.
    const used = new Set(combos.flatMap((c) => c.ids))
    expect(used.size).toBeLessThanOrEqual(MAX_COMBO_POOL)
  })

  it("returns nothing when no set adds up", () => {
    expect(findExactCombos(125, "2026-06-16", "USD", [inv({ id: "a", amount: 50 }), inv({ id: "b", amount: 52.5 })])).toEqual([])
    expect(findExactCombos(125, "2026-06-16", "USD", [])).toEqual([])
  })

  it("treats a paid invoice with no paid date as far away, not as a date match", () => {
    const combos = findExactCombos(125, "2026-06-16", "USD", [
      inv({ id: "a", amount: 50, paid_date: null }),
      inv({ id: "b", amount: 75, paid_date: "2026-06-16" }),
    ])
    expect(combos[0].dates_match).toBe(false)
  })
})

describe("daysApart", () => {
  it("counts calendar days and tolerates timestamps", () => {
    expect(daysApart("2026-06-16", "2026-06-19")).toBe(3)
    expect(daysApart("2026-06-19T10:00:00Z", "2026-06-16")).toBe(3)
    expect(daysApart(null, "2026-06-16")).toBeNull()
    expect(daysApart("garbage", "2026-06-16")).toBeNull()
  })
})
