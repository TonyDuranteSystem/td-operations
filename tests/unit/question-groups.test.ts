import { describe, it, expect } from "vitest"
import { merchantRoot, groupUncategorized, categoryForAnswer, type UncategorizedRow } from "@/lib/tax/question-groups"

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

  it("mixed direction when a merchant has both inflows and outflows", () => {
    const groups = groupUncategorized([row("a", "PayPal", -10), row("b", "PayPal", 100)])
    expect(groups[0].direction).toBe("mixed")
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
    expect(categoryForAnswer("nonsense")).toBeNull()
  })
})
