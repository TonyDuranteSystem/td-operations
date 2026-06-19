import { describe, it, expect } from "vitest"
import {
  slugifyBucket,
  getExpenseBuckets,
  isOperatingExpenseRow,
  bucketSlugForRow,
  OTHER_BUCKET_SLUG,
} from "@/lib/tax/expense-buckets"

describe("slugifyBucket", () => {
  it("normalizes case, spaces, and '&' so duplicates collapse", () => {
    expect(slugifyBucket("Gas ")).toBe("gas")
    expect(slugifyBucket("gas")).toBe("gas")
    expect(slugifyBucket("GAS")).toBe("gas")
    expect(slugifyBucket("Meals & Entertainment")).toBe("meals_and_entertainment")
    expect(slugifyBucket("  Software / SaaS  ")).toBe("software_saas")
  })

  it("trims leading/trailing separators and caps length", () => {
    expect(slugifyBucket("!!!Travel!!!")).toBe("travel")
    expect(slugifyBucket("x".repeat(60)).length).toBeLessThanOrEqual(40)
  })
})

describe("isOperatingExpenseRow", () => {
  it("counts booked expense and fee rows regardless of sign", () => {
    expect(isOperatingExpenseRow("expense", -100)).toBe(true)
    expect(isOperatingExpenseRow("fee", -5)).toBe(true)
    // defensive: a positive-signed expense/fee still counts (mirrors computePnlTotals)
    expect(isOperatingExpenseRow("expense", 100)).toBe(true)
  })

  it("counts uncategorized OUTFLOWS (default-to-expense) but not inflows", () => {
    expect(isOperatingExpenseRow("uncategorized", -50)).toBe(true)
    expect(isOperatingExpenseRow("uncategorized", 50)).toBe(false)
    expect(isOperatingExpenseRow(null, -50)).toBe(true) // null treated as uncategorized
    expect(isOperatingExpenseRow(undefined, -50)).toBe(true)
  })

  it("excludes COGS, distributions, contributions, income, conversions", () => {
    expect(isOperatingExpenseRow("cogs", -100)).toBe(false)
    expect(isOperatingExpenseRow("distribution", -100)).toBe(false)
    expect(isOperatingExpenseRow("contribution", 100)).toBe(false)
    expect(isOperatingExpenseRow("income", 100)).toBe(false)
    expect(isOperatingExpenseRow("conversion", -100)).toBe(false)
  })
})

describe("bucketSlugForRow", () => {
  const valid = new Set(["travel", "software_saas"])
  it("keeps a known catalog slug", () => {
    expect(bucketSlugForRow("travel", valid)).toBe("travel")
  })
  it("falls back to 'other' for unknown, missing, or non-string ai_bucket", () => {
    expect(bucketSlugForRow("not_a_bucket", valid)).toBe(OTHER_BUCKET_SLUG)
    expect(bucketSlugForRow(null, valid)).toBe(OTHER_BUCKET_SLUG)
    expect(bucketSlugForRow(undefined, valid)).toBe(OTHER_BUCKET_SLUG)
    expect(bucketSlugForRow(42, valid)).toBe(OTHER_BUCKET_SLUG)
  })
})

describe("getExpenseBuckets", () => {
  function fakeDb(rows: unknown[]) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      then: (resolve: (v: { data: unknown[] }) => unknown) => resolve({ data: rows }),
    }
    return { from: () => builder } as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it("orders by sort_order then label and returns slug+label only", async () => {
    const db = fakeDb([
      { slug: "other", display_name: "Other", metadata: { sort_order: 999 } },
      { slug: "travel", display_name: "Travel", metadata: { sort_order: 50 } },
      { slug: "software_saas", display_name: "Software & SaaS", metadata: { sort_order: 10 } },
    ])
    const out = await getExpenseBuckets(db)
    expect(out).toEqual([
      { slug: "software_saas", label: "Software & SaaS" },
      { slug: "travel", label: "Travel" },
      { slug: "other", label: "Other" },
    ])
  })

  it("defaults missing sort_order to the middle and tolerates null metadata", async () => {
    const db = fakeDb([
      { slug: "zzz", display_name: "Zzz", metadata: null },
      { slug: "aaa", display_name: "Aaa", metadata: null },
    ])
    const out = await getExpenseBuckets(db)
    // same default sort → alphabetical by label
    expect(out.map(b => b.slug)).toEqual(["aaa", "zzz"])
  })
})
