import { describe, it, expect } from "vitest"
import { slugifyBucket, getExpenseBuckets } from "@/lib/tax/expense-buckets"

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
