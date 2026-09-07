/**
 * Bookkeeper tab — the year selector must actually filter it.
 *
 * Until 2026-08-30 this tab destructured the year prop as unused and fetched every
 * review from every year, so the page's year selector was an inert control on this
 * tab: it looked like it filtered and did nothing. Same class of defect as the
 * "My Finances" menu entry that was shown to people the page then turned away.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf-8")

describe("Bookkeeper tab is year-scoped", () => {
  const tab = read("app/(dashboard)/owner/bookkeeper-tab.tsx")

  it("uses the year prop instead of discarding it", () => {
    expect(tab).toContain("export function BookkeeperTab({ year }")
    // The old signature renamed it to _year precisely to silence "unused".
    expect(tab).not.toContain("year: _year")
  })

  it("sends the year to the API and re-fetches when it changes", () => {
    expect(tab).toMatch(/\?year=\$\{year\}/)
    expect(tab).toMatch(/\}, \[year\]\)/)
  })

  it("clears the open review and its items on a year change", () => {
    // Items are fetched by review id, so a review left selected from the previous
    // year would keep showing that year's questions under the new year's heading.
    const effect = tab.slice(tab.indexOf("setLoadingReviews(true)"), tab.indexOf("}, [year])"))
    expect(effect).toContain("setSelectedReview(null)")
    expect(effect).toContain("setItems([])")
  })

  it("names the year in the empty state", () => {
    // An unqualified empty panel reads as broken rather than "try another year".
    expect(tab).toMatch(/No review sessions for \$\{year\}/)
  })
})

describe("Bookkeeper API year filter", () => {
  const route = read("app/api/owner/bookkeeper/route.ts")

  it("filters reviews by tax_year when a valid year is supplied", () => {
    expect(route).toContain("reviewsQuery.eq('tax_year', year)")
  })

  it("only accepts a 4-digit year, and treats anything else as no filter", () => {
    // A NaN/0 year must not silently become a filter that matches nothing —
    // that would render as "no reviews" and look like data loss.
    expect(route).toMatch(/\/\^\\d\{4\}\$\/\.test\(yearParam\)/)
    expect(route).toMatch(/: null/)
  })

  it("still guards on the owner", () => {
    expect(route).toContain("isOwnerOnly(user)")
  })
})
