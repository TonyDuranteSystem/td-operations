import { describe, it, expect } from "vitest"
import { merchantRoot, groupUncategorized, categoryForAnswer, groupKeyRoot, rowDirection, GROUP_KEY_SEP, type UncategorizedRow } from "@/lib/tax/question-groups"

function row(id: string, description: string, amount: number, date = "2025-06-01"): UncategorizedRow {
  return { id, description, counterparty: null, amount, transaction_date: date, bank_name: "Mercury" }
}

describe("merchantRoot", () => {
  it("strips card suffixes, embedded dates, long digit runs, extra spaces", () => {
    expect(merchantRoot("Glovo ••1266")).toBe("Glovo")
    expect(merchantRoot("Glovo  ••7229")).toBe("Glovo")
    expect(merchantRoot("Foreign Exch Rt ADJ Fee 10/13 Talabat Dubai")).toBe("Foreign Exch Rt ADJ Fee Talabat Dubai")
    expect(merchantRoot("Card Purchase 12/25 Talabat Dubai Card 579")).toBe("Card Purchase Talabat Dubai Card 579")
  })
})

describe("groupUncategorized", () => {
  it("groups card variants under one merchant, sorts by count, sums totals", () => {
    const groups = groupUncategorized([
      row("a", "Glovo ••1266", -10),
      row("b", "Glovo ••7229", -20),
      row("c", "Glovo  ••1266", -5),
      row("d", "Netflix ••7229", -12),
    ])
    expect(groups[0].label).toBe("Glovo")
    expect(groups[0].count).toBe(3)
    expect(groups[0].total).toBe(-35)
    expect(groups[0].direction).toBe("out")
    expect(groups[0].transaction_ids.sort()).toEqual(["a", "b", "c"])
    expect(groups[1].label).toBe("Netflix")
  })

  it("splits a mixed merchant into one card per direction (PayPal incident class)", () => {
    const groups = groupUncategorized([row("a", "PayPal", -10), row("b", "PayPal", 100), row("c", "PayPal", 50)])
    expect(groups).toHaveLength(2)
    const inG = groups.find(g => g.direction === "in")!
    const outG = groups.find(g => g.direction === "out")!
    expect(inG.count).toBe(2)
    expect(inG.total).toBe(150)
    expect(inG.transaction_ids.sort()).toEqual(["b", "c"])
    expect(outG.count).toBe(1)
    expect(outG.total).toBe(-10)
    expect(inG.label).toBe("PayPal")
    expect(outG.label).toBe("PayPal")
    expect(inG.group_key).not.toBe(outG.group_key)
    expect(groupKeyRoot(inG.group_key)).toBe(groupKeyRoot(outG.group_key))
  })

  it("splits by currency so a card never sums EUR+USD into one total", () => {
    const groups = groupUncategorized([
      { ...row("a", "Stripe", -10), currency: "USD" },
      { ...row("b", "Stripe", -20), currency: "USD" },
      { ...row("c", "Stripe", -30), currency: "EUR" },
    ])
    expect(groups).toHaveLength(2)
    const usd = groups.find(g => g.currency === "USD")!
    const eur = groups.find(g => g.currency === "EUR")!
    expect(usd.total).toBe(-30)
    expect(eur.total).toBe(-30)
    expect(groupKeyRoot(usd.group_key)).toBe(groupKeyRoot(eur.group_key))
  })

  it("zero-amount rows count as money in (explicit rule), and '#' in a description never truncates the root", () => {
    expect(rowDirection(0)).toBe("in")
    expect(rowDirection(-0.01)).toBe("out")
    const groups = groupUncategorized([row("a", "Online Transfer transaction#: ref A", -10)])
    expect(groupKeyRoot(groups[0].group_key)).not.toContain(GROUP_KEY_SEP)
    expect(groupKeyRoot(groups[0].group_key).length).toBeGreaterThan("Online Transfer".length - 1)
  })

  it("empty description falls back to counterparty, then a placeholder", () => {
    const groups = groupUncategorized([
      { id: "a", description: "", counterparty: "ACME", amount: -1, transaction_date: "2025-01-01", bank_name: "X" },
      { id: "b", description: "", counterparty: null, amount: -1, transaction_date: "2025-01-01", bank_name: "X" },
    ])
    expect(groups.map(g => g.label).sort()).toEqual(["(no description)", "ACME"])
  })
})

describe("categoryForAnswer", () => {
  it("maps every plain-language answer to the right category", () => {
    expect(categoryForAnswer("business_expense")).toEqual({ category: "expense", subcategory: "client_confirmed" })
    expect(categoryForAnswer("personal_spending")).toEqual({ category: "distribution", subcategory: "personal_draw" })
    expect(categoryForAnswer("business_income")).toEqual({ category: "income", subcategory: "revenue" })
    expect(categoryForAnswer("owner_money_in")).toEqual({ category: "contribution", subcategory: "capital_contribution" })
    expect(categoryForAnswer("own_transfer")).toEqual({ category: "conversion", subcategory: "internal_transfer" })
    expect(categoryForAnswer("bank_fee")).toEqual({ category: "fee", subcategory: "bank_fee" })
    expect(categoryForAnswer("refund")).toEqual({ category: "refund", subcategory: "client_confirmed" })
    expect(categoryForAnswer("nonsense")).toBeNull()
  })
})
